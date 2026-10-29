'use strict';

/**
 * RAMdagi rasm ombori.
 *
 * Bu modul server.js bilan faqat quyidagi interfeys orqali gaplashadi:
 *   add(), getLatest(), list(), get(), devices(), stats()
 * Keyinchalik doimiy saqlash (masalan S3 yoki Postgres) kerak bo'lsa, shu
 * interfeysni saqlagan holda yangi sinf yozib, server.js'da almashtirish kifoya.
 *
 * Eslatma: bepul Render instansiyasida RAM ham, disk ham vaqtinchalik.
 * Server qayta ishga tushsa yoki uyquga ketsa, bu yerdagi hamma narsa yo'qoladi.
 */

const crypto = require('node:crypto');
const { StoreError, DEFAULTS, positiveInt } = require('./storeCommon');

class ImageStore {
  /**
   * @param {object} [options]
   * @param {number} [options.maxDevices=2]
   * @param {number} [options.maxImagesPerDevice=10]
   * @param {number} [options.maxTotalBytes=41943040] barcha rasm baytlarining umumiy limiti
   */
  constructor(options = {}) {
    this.maxDevices = positiveInt(options.maxDevices, DEFAULTS.maxDevices);
    this.maxImagesPerDevice = positiveInt(options.maxImagesPerDevice, DEFAULTS.maxImagesPerDevice);
    this.maxTotalBytes = positiveInt(options.maxTotalBytes, DEFAULTS.maxTotalBytes);

    /** @type {Map<string, {deviceId: string, firstSeenAt: string, lastSeenAt: string, lastUptimeMs: number|null, images: object[]}>} */
    this._devices = new Map();
    /** @type {Map<string, object>} */
    this._byId = new Map();
    this._totalBytes = 0;
    this._seq = 0;
  }

  /**
   * Yangi rasm qo'shadi va limitlarni qo'llaydi.
   * @param {string} deviceId
   * @param {Buffer} buffer JPEG baytlari
   * @param {{uptimeMs?: number|null, width?: number|null, height?: number|null, receivedAt?: string}} [meta]
   * @returns {object} ochiq (buffer'siz) rasm yozuvi
   */
  add(deviceId, buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new StoreError('empty_image', "Bo'sh rasmni saqlab bo'lmaydi.");
    }
    if (buffer.length > this.maxTotalBytes) {
      throw new StoreError(
        'image_larger_than_store',
        `Rasm (${buffer.length} bayt) umumiy RAM limitidan (${this.maxTotalBytes} bayt) katta.`
      );
    }

    let device = this._devices.get(deviceId);
    if (!device) {
      if (this._devices.size >= this.maxDevices) {
        throw new StoreError(
          'device_limit_reached',
          `Eng ko'pi bilan ${this.maxDevices} ta qurilma qo'llab-quvvatlanadi.`
        );
      }
      device = {
        deviceId,
        firstSeenAt: meta.receivedAt || new Date().toISOString(),
        lastSeenAt: meta.receivedAt || new Date().toISOString(),
        lastUptimeMs: null,
        images: [],
      };
      this._devices.set(deviceId, device);
    }

    const receivedAt = meta.receivedAt || new Date().toISOString();
    const record = {
      id: crypto.randomBytes(12).toString('hex'),
      seq: ++this._seq,
      deviceId,
      receivedAt,
      uptimeMs: meta.uptimeMs === undefined ? null : meta.uptimeMs,
      width: meta.width === undefined ? null : meta.width,
      height: meta.height === undefined ? null : meta.height,
      bytes: buffer.length,
      buffer,
    };

    device.images.push(record); // eskidan yangiga qarab tartiblangan
    device.lastSeenAt = receivedAt;
    device.lastUptimeMs = record.uptimeMs;
    this._byId.set(record.id, record);
    this._totalBytes += record.bytes;

    // 1) Qurilma bo'yicha limit
    while (device.images.length > this.maxImagesPerDevice) {
      this._removeRecord(device.images[0]);
    }
    // 2) Umumiy RAM limiti: butun ombordagi eng eski rasmni o'chiramiz
    while (this._totalBytes > this.maxTotalBytes) {
      const oldest = this._oldestRecord();
      if (!oldest || oldest.id === record.id) break; // yangi rasm har doim qoladi
      this._removeRecord(oldest);
    }

    return publicView(record);
  }

  /** @returns {object|undefined} qurilmaning oxirgi rasmi (buffer'siz) */
  getLatest(deviceId) {
    const device = this._devices.get(deviceId);
    if (!device || device.images.length === 0) return undefined;
    return publicView(device.images[device.images.length - 1]);
  }

  /** Eng yangi rasm kelgan qurilma ID'si yoki undefined. */
  mostRecentDeviceId() {
    let best;
    let bestSeq = -1;
    for (const device of this._devices.values()) {
      const last = device.images[device.images.length - 1];
      if (last && last.seq > bestSeq) {
        bestSeq = last.seq;
        best = device.deviceId;
      }
    }
    return best;
  }

  hasDevice(deviceId) {
    return this._devices.has(deviceId);
  }

  /** Qurilmaning rasmlari, eng yangisi birinchi. */
  list(deviceId) {
    const device = this._devices.get(deviceId);
    if (!device) return [];
    return device.images.map(publicView).reverse();
  }

  /** @returns {object|undefined} rasm yozuvi buffer bilan birga */
  get(imageId) {
    return this._byId.get(imageId);
  }

  devices() {
    return Array.from(this._devices.values()).map((device) => {
      const last = device.images[device.images.length - 1];
      return {
        deviceId: device.deviceId,
        imageCount: device.images.length,
        firstSeenAt: device.firstSeenAt,
        lastSeenAt: device.lastSeenAt,
        lastUptimeMs: device.lastUptimeMs,
        latestImageId: last ? last.id : null,
        latestBytes: last ? last.bytes : null,
      };
    });
  }

  stats() {
    return {
      devices: this._devices.size,
      images: this._byId.size,
      totalBytes: this._totalBytes,
      limits: {
        maxDevices: this.maxDevices,
        maxImagesPerDevice: this.maxImagesPerDevice,
        maxTotalBytes: this.maxTotalBytes,
      },
    };
  }

  _oldestRecord() {
    let oldest;
    for (const device of this._devices.values()) {
      const first = device.images[0];
      if (first && (!oldest || first.seq < oldest.seq)) oldest = first;
    }
    return oldest;
  }

  _removeRecord(record) {
    const device = this._devices.get(record.deviceId);
    if (device) {
      const index = device.images.indexOf(record);
      if (index !== -1) device.images.splice(index, 1);
    }
    if (this._byId.delete(record.id)) this._totalBytes -= record.bytes;
  }
}

function publicView(record) {
  return {
    id: record.id,
    deviceId: record.deviceId,
    receivedAt: record.receivedAt,
    uptimeMs: record.uptimeMs,
    width: record.width,
    height: record.height,
    bytes: record.bytes,
  };
}

const { MongoStore } = require('./mongoStore');

module.exports = { ImageStore, MongoStore, StoreError, DEFAULTS };

