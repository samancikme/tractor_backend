'use strict';

/**
 * MongoDB dagi rasm ombori (MongoStore).
 *
 * Rasmlar va qurilmalar ma'lumotlarini doimiy ravishda MongoDB'da saqlaydi.
 * storage.js dagi ImageStore bilan aynan bir xil interfeysni taqdim etadi:
 *   add(), getLatest(), list(), get(), devices(), stats(), mostRecentDeviceId(), hasDevice(), close()
 */

const crypto = require('node:crypto');
const { MongoClient, Binary } = require('mongodb');
const { StoreError, DEFAULTS, positiveInt } = require('./storeCommon');

class MongoStore {
  /**
   * @param {object} [options]
   * @param {string} [options.uri] MongoDB ulanish URI manzili
   * @param {string} [options.dbName] Ma'lumotlar bazasi nomi
   * @param {MongoClient} [options.client] Mavjud MongoClient obyekti
   * @param {number} [options.maxDevices=2]
   * @param {number} [options.maxImagesPerDevice=10]
   * @param {number} [options.maxTotalBytes=41943040]
   */
  constructor(options = {}) {
    this.uri = options.uri || process.env.MONGODB_URI || 'mongodb://localhost:27017';
    this.dbName = options.dbName || process.env.MONGODB_DB_NAME || 'esp32_cam';
    this.client = options.client || null;
    this._ownsClient = !options.client;

    this.maxDevices = positiveInt(options.maxDevices, DEFAULTS.maxDevices);
    this.maxImagesPerDevice = positiveInt(options.maxImagesPerDevice, DEFAULTS.maxImagesPerDevice);
    this.maxTotalBytes = positiveInt(options.maxTotalBytes, DEFAULTS.maxTotalBytes);

    this._db = null;
    this._initPromise = null;
  }

  /** MongoDB'ga ulanish va indekslarni sozlash */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      if (!this.client) {
        this.client = new MongoClient(this.uri, {
          serverSelectionTimeoutMS: 10000,
        });
        await this.client.connect();
      }
      this._db = this.client.db(this.dbName);

      // Indekslarni yaratish
      await Promise.all([
        this.imagesCol.createIndex({ deviceId: 1, createdAt: -1, _id: -1 }),
        this.imagesCol.createIndex({ createdAt: -1 }),
        this.devicesCol.createIndex({ lastSeenAt: -1 }),
      ]);
      return this;
    })();
    return this._initPromise;
  }

  get db() {
    if (!this._db) {
      throw new Error("MongoStore hali ishga tushirilmagan. Avval init() chaqiring.");
    }
    return this._db;
  }

  get devicesCol() {
    return this.db.collection('devices');
  }

  get imagesCol() {
    return this.db.collection('images');
  }

  /**
   * Yangi rasm qo'shadi va limitlarni qo'llaydi.
   * @param {string} deviceId
   * @param {Buffer} buffer JPEG baytlari
   * @param {{uptimeMs?: number|null, width?: number|null, height?: number|null, receivedAt?: string}} [meta]
   * @returns {Promise<object>} ochiq (buffer'siz) rasm yozuvi
   */
  async add(deviceId, buffer, meta = {}) {
    await this.init();

    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new StoreError('empty_image', "Bo'sh rasmni saqlab bo'lmaydi.");
    }
    if (buffer.length > this.maxTotalBytes) {
      throw new StoreError(
        'image_larger_than_store',
        `Rasm (${buffer.length} bayt) umumiy limitdan (${this.maxTotalBytes} bayt) katta.`
      );
    }

    const now = new Date();
    const receivedAt = meta.receivedAt || now.toISOString();

    // 1) Qurilmani tekshiramiz yoki qo'shamiz
    let device = await this.devicesCol.findOne({ _id: deviceId });
    if (!device) {
      const deviceCount = await this.devicesCol.countDocuments();
      if (deviceCount >= this.maxDevices) {
        throw new StoreError(
          'device_limit_reached',
          `Eng ko'pi bilan ${this.maxDevices} ta qurilma qo'llab-quvvatlanadi.`
        );
      }
      device = {
        _id: deviceId,
        deviceId,
        firstSeenAt: receivedAt,
        lastSeenAt: receivedAt,
        lastUptimeMs: meta.uptimeMs === undefined ? null : meta.uptimeMs,
        imageCount: 0,
        latestImageId: null,
        latestBytes: null,
      };
      await this.devicesCol.insertOne(device);
    }

    const imageId = crypto.randomBytes(12).toString('hex');
    const record = {
      _id: imageId,
      id: imageId,
      deviceId,
      receivedAt,
      uptimeMs: meta.uptimeMs === undefined ? null : meta.uptimeMs,
      width: meta.width === undefined ? null : meta.width,
      height: meta.height === undefined ? null : meta.height,
      bytes: buffer.length,
      buffer: new Binary(buffer),
      createdAt: now,
    };

    await this.imagesCol.insertOne(record);

    // Qurilma metama'lumotlarini yangilash
    await this.devicesCol.updateOne(
      { _id: deviceId },
      {
        $set: {
          lastSeenAt: receivedAt,
          lastUptimeMs: record.uptimeMs,
          latestImageId: record.id,
          latestBytes: record.bytes,
        },
        $inc: { imageCount: 1 },
      }
    );

    // 2) Qurilma bo'yicha rasm soni limiti (maxImagesPerDevice)
    const excessImages = await this.imagesCol
      .find({ deviceId }, { projection: { _id: 1, bytes: 1 } })
      .sort({ createdAt: -1, _id: -1 })
      .skip(this.maxImagesPerDevice)
      .toArray();

    if (excessImages.length > 0) {
      const excessIds = excessImages.map((doc) => doc._id);
      await this.imagesCol.deleteMany({ _id: { $in: excessIds } });
      await this.devicesCol.updateOne(
        { _id: deviceId },
        { $inc: { imageCount: -excessIds.length } }
      );
    }

    // 3) Umumiy baytlar limiti (maxTotalBytes)
    const statsResult = await this.imagesCol
      .aggregate([{ $group: { _id: null, totalBytes: { $sum: '$bytes' } } }])
      .toArray();
    let totalBytes = statsResult.length > 0 ? statsResult[0].totalBytes : 0;

    if (totalBytes > this.maxTotalBytes) {
      // Eng eski rasmlarni yangi rasmga tegmagan holda navbati bilan o'chiramiz
      const cursor = this.imagesCol
        .find({ _id: { $ne: record.id } }, { projection: { _id: 1, deviceId: 1, bytes: 1 } })
        .sort({ createdAt: 1, _id: 1 });

      for await (const oldImg of cursor) {
        if (totalBytes <= this.maxTotalBytes) break;
        await this.imagesCol.deleteOne({ _id: oldImg._id });
        await this.devicesCol.updateOne(
          { _id: oldImg.deviceId },
          { $inc: { imageCount: -1 } }
        );
        totalBytes -= oldImg.bytes;
      }
    }

    return publicView(record);
  }

  /** @returns {Promise<object|undefined>} qurilmaning oxirgi rasmi (buffer'siz) */
  async getLatest(deviceId) {
    await this.init();
    const doc = await this.imagesCol
      .find({ deviceId }, { projection: { buffer: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .next();
    return doc ? publicView(doc) : undefined;
  }

  /** Eng yangi rasm kelgan qurilma ID'si yoki undefined. */
  async mostRecentDeviceId() {
    await this.init();
    const doc = await this.imagesCol
      .find({}, { projection: { deviceId: 1 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .next();
    return doc ? doc.deviceId : undefined;
  }

  async hasDevice(deviceId) {
    await this.init();
    const count = await this.devicesCol.countDocuments({ _id: deviceId });
    return count > 0;
  }

  /** Qurilmaning rasmlari, eng yangisi birinchi. */
  async list(deviceId) {
    await this.init();
    const docs = await this.imagesCol
      .find({ deviceId }, { projection: { buffer: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(this.maxImagesPerDevice)
      .toArray();
    return docs.map(publicView);
  }

  /** @returns {Promise<object|undefined>} rasm yozuvi buffer bilan birga */
  async get(imageId) {
    await this.init();
    const doc = await this.imagesCol.findOne({ _id: imageId });
    if (!doc) return undefined;

    let buf;
    if (Buffer.isBuffer(doc.buffer)) {
      buf = doc.buffer;
    } else if (doc.buffer && doc.buffer.buffer) {
      buf = Buffer.from(doc.buffer.buffer);
    } else if (doc.buffer) {
      buf = Buffer.from(doc.buffer);
    }

    return {
      id: doc.id || doc._id,
      deviceId: doc.deviceId,
      receivedAt: doc.receivedAt,
      uptimeMs: doc.uptimeMs,
      width: doc.width,
      height: doc.height,
      bytes: doc.bytes,
      buffer: buf,
    };
  }

  async devices() {
    await this.init();
    const list = await this.devicesCol.find().toArray();
    return list.map((device) => ({
      deviceId: device.deviceId || device._id,
      imageCount: device.imageCount || 0,
      firstSeenAt: device.firstSeenAt,
      lastSeenAt: device.lastSeenAt,
      lastUptimeMs: device.lastUptimeMs,
      latestImageId: device.latestImageId,
      latestBytes: device.latestBytes,
    }));
  }

  async stats() {
    await this.init();
    const [deviceCount, imageCount, statsResult] = await Promise.all([
      this.devicesCol.countDocuments(),
      this.imagesCol.countDocuments(),
      this.imagesCol.aggregate([{ $group: { _id: null, totalBytes: { $sum: '$bytes' } } }]).toArray(),
    ]);

    const totalBytes = statsResult.length > 0 ? statsResult[0].totalBytes : 0;
    return {
      devices: deviceCount,
      images: imageCount,
      totalBytes,
      limits: {
        maxDevices: this.maxDevices,
        maxImagesPerDevice: this.maxImagesPerDevice,
        maxTotalBytes: this.maxTotalBytes,
      },
    };
  }

  /** Ulanishni yopish */
  async close() {
    if (this._ownsClient && this.client) {
      await this.client.close();
      this.client = null;
      this._db = null;
      this._initPromise = null;
    }
  }
}

function publicView(record) {
  return {
    id: record.id || record._id,
    deviceId: record.deviceId,
    receivedAt: record.receivedAt,
    uptimeMs: record.uptimeMs,
    width: record.width,
    height: record.height,
    bytes: record.bytes,
  };
}

module.exports = { MongoStore };
