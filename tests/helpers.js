'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { createApp } = require('../server');

const silentLogger = { log() {}, warn() {}, error() {} };

/** Bir rangli kichik JPEG. */
async function solidJpeg(width = 64, height = 48, color = { r: 180, g: 40, b: 40 }) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** Tasodifiy shovqinli JPEG (siqilmaydi, shuning uchun kesilganini aniq sezish mumkin). */
async function noiseJpeg(width = 200, height = 150) {
  const raw = crypto.randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** Ilovani tasodifiy bo'sh portda ishga tushiradi. */
async function listen(options = {}) {
  const app = createApp({ apiToken: '', logger: silentLogger, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    app,
    store: app.locals.store,
    base: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function withServer(options, fn) {
  const s = await listen(options);
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

/** ESP32-CAM kabi to'g'ridan-to'g'ri JPEG baytlarini POST /upload ga yuboradi. */
async function upload(base, body, opts = {}) {
  const { deviceId = 'TRAKTOR-CAM-01', token, uptime = '123456', contentType = 'image/jpeg', headers = {} } = opts;
  const h = { ...headers };
  if (contentType !== null) h['Content-Type'] = contentType;
  if (deviceId !== null) h['X-Device-ID'] = deviceId;
  if (uptime !== null) h['X-Uptime-Ms'] = uptime;
  if (token !== undefined) h.Authorization = token;
  const res = await fetch(`${base}/upload`, { method: 'POST', headers: h, body });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { http, silentLogger, solidJpeg, noiseJpeg, listen, withServer, upload, getJson, sleep };
