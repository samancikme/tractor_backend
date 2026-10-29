'use strict';

/**
 * ESP32-CAM rasm qabul qiluvchi server + monitoring sahifasi.
 *
 * Qurilma har ~5 soniyada to'g'ridan-to'g'ri JPEG baytlarini POST /upload ga yuboradi
 * (multipart ham, base64 ham, JSON ham emas). Rasmlar faqat RAMda saqlanadi (storage.js).
 */

const path = require('node:path');
const crypto = require('node:crypto');

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (err) {
  if (err && err.code !== 'ENOENT') console.warn('[server] .env yuklashda xatolik:', err.message);
}

const express = require('express');
const sharp = require('sharp');
const { ImageStore, MongoStore, StoreError } = require('./storage');

// Bepul instansiya uchun kam resurs: sharp keshi va parallel iplarini cheklaymiz.
sharp.cache(false);
sharp.concurrency(1);

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_ID_RE = /^[a-f0-9]{24}$/;
const UPTIME_RE = /^\d{1,15}$/; // qurilma yoqilganidan beri o'tgan millisekundlar (sana emas)
const FAIL_ON_LEVELS = new Set(['truncated', 'error', 'warning']);

const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_MAX_PIXELS = 8_000_000; // 8 megapiksel; OV2640 (2 MP) uchun bemalol yetadi
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;

class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function sendError(res, status, code, message, headers) {
  if (headers) res.set(headers);
  res.status(status).json({ ok: false, error: code, message });
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Token tekshiruvi: vaqt bo'yicha farq bildirmaydigan taqqoslash. */
function bearerMatches(expectedToken, headerValue) {
  if (typeof headerValue !== 'string') return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headerValue.trim());
  if (!match) return false;
  const a = crypto.createHash('sha256').update(match[1]).digest();
  const b = crypto.createHash('sha256').update(expectedToken).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * JPEG haqiqiyligini sharp orqali tekshiradi:
 *  1) sarlavha o'qiladi (format 'jpeg' bo'lishi shart),
 *  2) piksel soni limitdan oshmasligi tekshiriladi,
 *  3) rasm to'liq dekodlanadi (kesilgan/buzilgan fayl shu yerda xato beradi).
 */
async function validateJpeg(buffer, { maxPixels, failOn }) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new HttpError(422, 'invalid_jpeg', 'Fayl JPEG emas (JPEG sarlavhasi topilmadi).');
  }
  const options = { limitInputPixels: maxPixels, failOn, sequentialRead: true };

  let meta;
  try {
    meta = await sharp(buffer, options).metadata();
  } catch (err) {
    throw classifySharpError(err);
  }
  if (meta.format !== 'jpeg' || !meta.width || !meta.height) {
    throw new HttpError(422, 'invalid_jpeg', 'Fayl JPEG emas yoki o\'lchamlari o\'qilmadi.');
  }
  if (meta.width * meta.height > maxPixels) {
    throw new HttpError(
      422,
      'image_too_many_pixels',
      `Rasm juda katta: ${meta.width}x${meta.height} (limit ${maxPixels} piksel).`
    );
  }
  try {
    await sharp(buffer, options).stats(); // to'liq dekodlashni majburlaydi
  } catch (err) {
    throw classifySharpError(err);
  }
  return { width: meta.width, height: meta.height };
}

function classifySharpError(err) {
  const message = String((err && err.message) || '');
  if (/pixel limit/i.test(message)) {
    return new HttpError(422, 'image_too_many_pixels', 'Rasm piksel limitidan oshdi.');
  }
  return new HttpError(422, 'invalid_jpeg', 'JPEG buzilgan yoki to\'liq emas.');
}

function toApiImage(record) {
  return {
    image_id: record.id,
    device_id: record.deviceId,
    received_at: record.receivedAt,
    uptime_ms: record.uptimeMs,
    bytes: record.bytes,
    width: record.width,
    height: record.height,
    image_url: `/images/${record.id}`,
  };
}

/**
 * Ilovani yaratadi (listen qilmaydi) — testlar uchun qulay.
 * @param {object} [options]
 */
function createApp(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const apiToken =
    options.apiToken !== undefined ? String(options.apiToken).trim() : String(env.API_TOKEN || '').trim();
  const maxImageBytes = parsePositiveInt(options.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES);
  const maxPixels = parsePositiveInt(options.maxPixels, parsePositiveInt(env.MAX_PIXELS, DEFAULT_MAX_PIXELS));
  const maxConcurrentUploads = parsePositiveInt(options.maxConcurrentUploads, DEFAULT_MAX_CONCURRENT_UPLOADS);
  const failOnRaw = options.jpegFailOn || env.JPEG_FAIL_ON || 'error';
  const failOn = FAIL_ON_LEVELS.has(failOnRaw) ? failOnRaw : 'error';
  const mongodbUri = options.mongodbUri || env.MONGODB_URI;
  const store =
    options.store ||
    (mongodbUri
      ? new MongoStore({
          uri: mongodbUri,
          dbName: options.mongodbDbName || env.MONGODB_DB_NAME,
          maxDevices: options.maxDevices || env.MAX_DEVICES,
          maxImagesPerDevice: options.maxImagesPerDevice || env.MAX_IMAGES_PER_DEVICE,
          maxTotalBytes: options.maxTotalBytes || env.MAX_TOTAL_BYTES,
        })
      : new ImageStore(options.storeOptions));
  const publicDir = options.publicDir || path.join(__dirname, 'public');

  const app = express();
  app.disable('x-powered-by');

  // ---- CORS va umumiy sarlavhalar ----
  app.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-ID, X-Uptime-Ms',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };

  // ---- Health ----
  app.get('/health', noStore, async (req, res, next) => {
    try {
      const stats = await store.stats();
      res.json({
        ok: true,
        status: 'ok',
        uptime_s: Math.round(process.uptime()),
        devices: stats.devices,
        images: stats.images,
        total_bytes: stats.totalBytes,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Upload ----
  let activeUploads = 0;

  const logRejectedUploads = (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) {
        const device = JSON.stringify(String(req.get('x-device-id') || '').slice(0, 64));
        logger.warn(`[upload] rad etildi: status=${res.statusCode} device=${device}`);
      }
    });
    next();
  };

  const checkAuth = (req, res, next) => {
    if (!apiToken) return next(); // token sozlanmagan: lokal test rejimi
    if (bearerMatches(apiToken, req.get('authorization'))) return next();
    return sendError(res, 401, 'unauthorized', "Token noto'g'ri yoki yuborilmagan.", {
      'WWW-Authenticate': 'Bearer',
    });
  };

  const checkHeaders = (req, res, next) => {
    const contentType = String(req.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'image/jpeg') {
      return sendError(res, 415, 'unsupported_media_type', 'Content-Type: image/jpeg bo\'lishi kerak.');
    }

    const deviceId = req.get('x-device-id');
    if (deviceId === undefined || deviceId === '') {
      return sendError(res, 400, 'missing_device_id', 'X-Device-ID sarlavhasi yuborilmagan.');
    }
    if (!DEVICE_ID_RE.test(deviceId)) {
      return sendError(
        res,
        400,
        'invalid_device_id',
        "X-Device-ID faqat harf, raqam, '-' va '_' dan iborat bo'lib, 64 belgidan oshmasligi kerak."
      );
    }

    const uptimeHeader = req.get('x-uptime-ms');
    let uptimeMs = null;
    if (uptimeHeader !== undefined) {
      if (!UPTIME_RE.test(uptimeHeader.trim())) {
        return sendError(res, 400, 'invalid_uptime', "X-Uptime-Ms manfiy bo'lmagan butun son bo'lishi kerak.");
      }
      uptimeMs = Number(uptimeHeader.trim());
    }

    req.upload = { deviceId, uptimeMs };
    return next();
  };

  const limitConcurrency = (req, res, next) => {
    if (activeUploads >= maxConcurrentUploads) {
      return sendError(res, 503, 'server_busy', "Server band, keyinroq qayta urinib ko'ring.", {
        'Retry-After': '5',
      });
    }
    activeUploads += 1;
    let released = false;
    res.on('close', () => {
      if (!released) {
        released = true;
        activeUploads -= 1;
      }
    });
    return next();
  };

  const rawJpeg = express.raw({ type: 'image/jpeg', limit: maxImageBytes, inflate: false });

  const handleUpload = async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return sendError(res, 400, 'empty_body', "So'rov tanasi bo'sh: JPEG baytlari yuborilmagan.");
    }

    const { width, height } = await validateJpeg(body, { maxPixels, failOn });
    const { deviceId, uptimeMs } = req.upload;
    const receivedAt = new Date().toISOString(); // UTC (ISO 8601, 'Z' bilan)

    let record;
    try {
      record = await store.add(deviceId, body, { uptimeMs, width, height, receivedAt });
    } catch (err) {
      if (err instanceof StoreError) {
        if (err.code === 'device_limit_reached') throw new HttpError(409, err.code, err.message);
        throw new HttpError(413, err.code, err.message);
      }
      throw err;
    }

    res.status(201).json({
      ok: true,
      image_id: record.id,
      device_id: record.deviceId,
      received_at: record.receivedAt,
      image_url: `/images/${record.id}`,
    });
  };

  app.post(
    '/upload',
    noStore,
    logRejectedUploads,
    checkAuth,
    checkHeaders,
    limitConcurrency,
    rawJpeg,
    handleUpload
  );
  app.all('/upload', (req, res) => {
    sendError(res, 405, 'method_not_allowed', 'Bu manzilga faqat POST yuborish mumkin.', { Allow: 'POST' });
  });

  // ---- Ma'lumot endpointlari ----
  /** device_id so'rov parametrini tekshiradi. undefined qaytarsa, javob allaqachon yuborilgan. */
  const readDeviceQuery = (req, res) => {
    const raw = req.query.device_id;
    if (raw === undefined) return null; // ko'rsatilmagan
    if (typeof raw !== 'string' || !DEVICE_ID_RE.test(raw)) {
      sendError(res, 400, 'invalid_device_id', "device_id noto'g'ri formatda.");
      return undefined;
    }
    return raw;
  };

  app.get('/api/devices', noStore, async (req, res, next) => {
    try {
      const stats = await store.stats();
      const devList = await store.devices();
      res.json({
        ok: true,
        server_time: new Date().toISOString(),
        devices: devList.map((d) => ({
          device_id: d.deviceId,
          image_count: d.imageCount,
          first_seen_at: d.firstSeenAt,
          last_received_at: d.lastSeenAt,
          last_uptime_ms: d.lastUptimeMs,
          latest_image_id: d.latestImageId,
          latest_bytes: d.latestBytes,
        })),
        limits: {
          max_devices: stats.limits.maxDevices,
          max_images_per_device: stats.limits.maxImagesPerDevice,
          max_total_bytes: stats.limits.maxTotalBytes,
        },
        storage: { images: stats.images, total_bytes: stats.totalBytes },
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/latest', noStore, async (req, res, next) => {
    try {
      const requested = readDeviceQuery(req, res);
      if (requested === undefined) return;
      if (requested && !(await store.hasDevice(requested))) {
        return sendError(res, 404, 'device_not_found', `Qurilma topilmadi: ${requested}`);
      }
      const deviceId = requested || (await store.mostRecentDeviceId());
      const latest = deviceId ? await store.getLatest(deviceId) : undefined;
      if (!latest) {
        return sendError(res, 404, 'no_images', 'Hali birorta rasm kelmagan.');
      }
      return res.json({ ok: true, server_time: new Date().toISOString(), image: toApiImage(latest) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/images', noStore, async (req, res, next) => {
    try {
      const requested = readDeviceQuery(req, res);
      if (requested === undefined) return;
      if (requested && !(await store.hasDevice(requested))) {
        return sendError(res, 404, 'device_not_found', `Qurilma topilmadi: ${requested}`);
      }
      const deviceId = requested || (await store.mostRecentDeviceId()) || null;
      const images = deviceId ? (await store.list(deviceId)).map(toApiImage) : [];
      return res.json({ ok: true, server_time: new Date().toISOString(), device_id: deviceId, images });
    } catch (err) {
      next(err);
    }
  });

  app.get('/images/:imageId', async (req, res, next) => {
    try {
      const { imageId } = req.params;
      const record = IMAGE_ID_RE.test(imageId) ? await store.get(imageId) : undefined;
      if (!record) {
        res.set('Cache-Control', 'no-store');
        return sendError(res, 404, 'image_not_found', 'Rasm topilmadi (u eskirib o\'chirilgan yoki server qayta ishga tushgan bo\'lishi mumkin).');
      }
      res.set('Cache-Control', 'private, max-age=31536000, immutable'); // rasm ID'si o'zgarmas
      if (req.query.download !== undefined) {
        const stamp = record.receivedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        res.attachment(`${record.deviceId}_${stamp}.jpg`);
      }
      res.type('image/jpeg');
      return res.send(record.buffer);
    } catch (err) {
      next(err);
    }
  });

  // ---- Frontend ----
  app.use(express.static(publicDir, { index: 'index.html' }));

  // ---- 404 va xatolar ----
  app.use((req, res) => {
    sendError(res, 404, 'not_found', 'Bunday manzil mavjud emas.');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message, err.headers);
    switch (err && err.type) {
      case 'entity.too.large':
        return sendError(
          res,
          413,
          'image_too_large',
          `Rasm hajmi ${maxImageBytes} baytdan (${(maxImageBytes / 1048576).toFixed(1)} MB) oshmasligi kerak.`
        );
      case 'request.aborted':
        return sendError(res, 400, 'request_aborted', "So'rov to'liq yuborilmay uzildi.");
      case 'request.size.invalid':
        return sendError(res, 400, 'content_length_mismatch', "Content-Length haqiqiy hajmga mos kelmadi.");
      case 'encoding.unsupported':
        return sendError(res, 415, 'unsupported_encoding', "Content-Encoding qo'llab-quvvatlanmaydi.");
      default:
        break;
    }
    if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
      return sendError(res, err.status, 'bad_request', "So'rovni o'qib bo'lmadi.");
    }
    logger.error('[server] kutilmagan xato:', err);
    return sendError(res, 500, 'internal_error', 'Serverda ichki xato yuz berdi.');
  });

  app.locals.store = store;
  app.locals.config = { maxImageBytes, maxPixels, failOn, tokenRequired: Boolean(apiToken) };
  return app;
}

/** Serverni ishga tushiradi (Render uchun 0.0.0.0 va process.env.PORT). */
function start(env = process.env) {
  const port = parsePositiveInt(env.PORT, 3000);
  const host = '0.0.0.0';
  const app = createApp({ env });

  if (!app.locals.config.tokenRequired) {
    console.warn(
      "[server] OGOHLANTIRISH: API_TOKEN sozlanmagan — /upload hamma uchun ochiq. Internetga chiqarishdan oldin API_TOKEN o'rnating."
    );
  }

  const server = app.listen(port, host, () => {
    console.log(`[server] http://${host}:${port} da tinglayapti`);
  });

  // Teskari proksi orqasida kutilmagan 502 xatolarini kamaytirish uchun odatiy sozlamalar.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000; // 2 MB gacha rasm yuklash uchun yetarli

  if (app.locals.store && typeof app.locals.store.init === 'function') {
    app.locals.store
      .init()
      .then(() => {
        console.log('[server] MongoDB ombori muvaffaqiyatli ulandi');
      })
      .catch((err) => {
        console.error('[server] MongoDB ulanishida xatolik:', err.message);
      });
  }

  const shutdown = async (signal) => {
    console.log(`[server] ${signal} olindi, to'xtatilmoqda`);
    if (app.locals.store && typeof app.locals.store.close === 'function') {
      try {
        await app.locals.store.close();
      } catch (err) {
        console.error('[server] omborni yopishda xatolik:', err);
      }
    }
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.app = app;
  server.store = app.locals.store;

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { createApp, start, bearerMatches, validateJpeg, DEVICE_ID_RE };
