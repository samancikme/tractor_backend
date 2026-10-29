'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { start } = require('../server');
const { solidJpeg, noiseJpeg, withServer, upload, getJson, sleep } = require('./helpers');

const HEX24 = /^[a-f0-9]{24}$/;

// ---------------------------------------------------------------- /upload: muvaffaqiyatli holat

test('POST /upload: to\'g\'ri JPEG 201 va kutilgan JSON qaytaradi', async () => {
  const jpeg = await solidJpeg();
  await withServer({}, async ({ base }) => {
    const before = Date.now();
    const res = await upload(base, jpeg, { deviceId: 'TRAKTOR-CAM-01', uptime: '123456' });
    assert.equal(res.status, 201);
    assert.equal(res.json.ok, true);
    assert.match(res.json.image_id, HEX24);
    assert.equal(res.json.device_id, 'TRAKTOR-CAM-01');
    assert.equal(res.json.image_url, `/images/${res.json.image_id}`);

    // Qabul vaqti UTC (ISO 8601, 'Z' bilan) va hozirgi vaqtga yaqin
    assert.match(res.json.received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const receivedMs = Date.parse(res.json.received_at);
    assert.ok(receivedMs >= before - 1000 && receivedMs <= Date.now() + 1000);

    // Rasm endpointi aynan o'sha baytlarni image/jpeg sifatida qaytaradi
    const img = await fetch(`${base}${res.json.image_url}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(jpeg));
  });
});

test('X-Uptime-Ms qurilma ishlash vaqti sifatida saqlanadi (sana emas)', async () => {
  const jpeg = await solidJpeg();
  await withServer({}, async ({ base }) => {
    await upload(base, jpeg, { uptime: '987654' });
    const latest = await getJson(base, '/api/latest?device_id=TRAKTOR-CAM-01');
    assert.equal(latest.json.image.uptime_ms, 987654);
    assert.equal(latest.json.image.width, 64);
    assert.equal(latest.json.image.height, 48);
    assert.equal(latest.json.image.bytes, jpeg.length);
  });
});

test('Content-Type parametrlari (charset) bilan ham qabul qilinadi; X-Uptime-Ms ixtiyoriy', async () => {
  const jpeg = await solidJpeg();
  await withServer({}, async ({ base }) => {
    const res = await upload(base, jpeg, { contentType: 'image/jpeg; charset=binary', uptime: null });
    assert.equal(res.status, 201);
    const latest = await getJson(base, '/api/latest?device_id=TRAKTOR-CAM-01');
    assert.equal(latest.json.image.uptime_ms, null);
  });
});

// ---------------------------------------------------------------- token

test('API_TOKEN sozlangan: tokensiz so\'rov 401', async () => {
  const jpeg = await solidJpeg();
  await withServer({ apiToken: 'secret-token-123' }, async ({ base, store }) => {
    const res = await upload(base, jpeg);
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'unauthorized');
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    assert.equal(store.stats().images, 0);
  });
});

test('API_TOKEN sozlangan: noto\'g\'ri token va noto\'g\'ri sxema 401', async () => {
  const jpeg = await solidJpeg();
  await withServer({ apiToken: 'secret-token-123' }, async ({ base, store }) => {
    for (const token of ['Bearer wrong-token', 'Bearer secret-token-12', 'Bearer secret-token-1234', 'Basic secret-token-123', 'secret-token-123', 'Bearer']) {
      const res = await upload(base, jpeg, { token });
      assert.equal(res.status, 401, `token: ${token}`);
    }
    assert.equal(store.stats().images, 0);
  });
});

test('API_TOKEN sozlangan: to\'g\'ri token bilan 201', async () => {
  const jpeg = await solidJpeg();
  await withServer({ apiToken: 'secret-token-123' }, async ({ base, store }) => {
    const res = await upload(base, jpeg, { token: 'Bearer secret-token-123' });
    assert.equal(res.status, 201);
    assert.equal(store.stats().images, 1);
  });
});

test('token tekshiruvi tana tekshiruvidan oldin: noto\'g\'ri token + buzuq rasm = 401', async () => {
  await withServer({ apiToken: 'secret-token-123' }, async ({ base }) => {
    const res = await upload(base, Buffer.from('not a jpeg'), { token: 'Bearer nope' });
    assert.equal(res.status, 401);
  });
});

test('API_TOKEN bo\'sh bo\'lsa lokal testda tokensiz ishlaydi', async () => {
  const jpeg = await solidJpeg();
  await withServer({ apiToken: '' }, async ({ base }) => {
    const res = await upload(base, jpeg); // Authorization yo'q
    assert.equal(res.status, 201);
  });
});

test('API_TOKEN frontendga va ochiq endpointlarga chiqmaydi', async () => {
  const token = 'super-secret-token-xyz-987';
  const jpeg = await solidJpeg();
  await withServer({ apiToken: token }, async ({ base }) => {
    await upload(base, jpeg, { token: `Bearer ${token}` });
    for (const path of ['/', '/index.html', '/app.js', '/style.css', '/health', '/api/devices', '/api/latest', '/api/images']) {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      assert.ok(!text.includes(token), `${path} tokenni oshkor qildi`);
      for (const [, value] of res.headers) assert.ok(!value.includes(token), `${path} sarlavhada tokenni oshkor qildi`);
    }
  });
});

// ---------------------------------------------------------------- buzilgan JPEG

test('buzilgan JPEG: kesilgan fayl 422 invalid_jpeg', async () => {
  const full = await noiseJpeg();
  const truncated = full.subarray(0, Math.floor(full.length * 0.6));
  await withServer({}, async ({ base, store }) => {
    const res = await upload(base, truncated);
    assert.equal(res.status, 422);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'invalid_jpeg');
    assert.equal(store.stats().images, 0);
  });
});

test('buzilgan JPEG: JPEG sarlavhali tasodifiy axlat 422', async () => {
  const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('this is definitely not image data'.repeat(20))]);
  await withServer({}, async ({ base, store }) => {
    const res = await upload(base, garbage);
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'invalid_jpeg');
    assert.equal(store.stats().images, 0);
  });
});

test('buzilgan JPEG: matn va PNG (image/jpeg deb yuborilsa) 422', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } }).png().toBuffer();
  await withServer({}, async ({ base, store }) => {
    assert.equal((await upload(base, Buffer.from('hello world'))).status, 422);
    assert.equal((await upload(base, png)).status, 422);
    assert.equal(store.stats().images, 0);
  });
});

test('bo\'sh tana 400 empty_body', async () => {
  await withServer({}, async ({ base }) => {
    const res = await upload(base, Buffer.alloc(0));
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'empty_body');
  });
});

test('piksel limiti: juda katta o\'lchamdagi rasm 422', async () => {
  const small = await solidJpeg(64, 48);
  const huge = await solidJpeg(400, 300); // 120 000 piksel, lekin hajmi kichik
  await withServer({ maxPixels: 50_000 }, async ({ base, store }) => {
    assert.equal((await upload(base, small)).status, 201);
    const res = await upload(base, huge);
    assert.equal(res.status, 422);
    assert.equal(res.json.error, 'image_too_many_pixels');
    assert.equal(store.stats().images, 1);
  });
});

// ---------------------------------------------------------------- hajm cheklovi

test('2 MB dan katta so\'rov 413 image_too_large (standart limit)', async () => {
  const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1, 0xab);
  tooBig[0] = 0xff;
  tooBig[1] = 0xd8;
  tooBig[2] = 0xff;
  await withServer({}, async ({ base, store }) => {
    const res = await upload(base, tooBig);
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'image_too_large');
    assert.equal(store.stats().images, 0);
  });
});

test('limitga teng hajmdagi rasm o\'tadi, bir bayt ko\'pi 413', async () => {
  const jpeg = await solidJpeg();
  await withServer({ maxImageBytes: jpeg.length }, async ({ base }) => {
    assert.equal((await upload(base, jpeg)).status, 201);
    const plusOne = Buffer.concat([jpeg, Buffer.from([0])]);
    const res = await upload(base, plusOne);
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'image_too_large');
  });
});

// ---------------------------------------------------------------- sarlavhalar

test('X-Device-ID tekshiruvi', async () => {
  const jpeg = await solidJpeg();
  // Bu testda 4 ta turli ID sinaladi, shuning uchun qurilma limiti vaqtincha oshiriladi.
  await withServer({ storeOptions: { maxDevices: 10 } }, async ({ base }) => {
    let res = await upload(base, jpeg, { deviceId: null });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'missing_device_id');

    for (const bad of ['bad/id', 'bad id', 'a.b', 'x'.repeat(65), 'dev;rm']) {
      res = await upload(base, jpeg, { deviceId: bad });
      assert.equal(res.status, 400, `qurilma ID: ${bad}`);
      assert.equal(res.json.error, 'invalid_device_id');
    }

    for (const good of ['TRAKTOR-CAM-01', 'cam_2', 'A', 'x'.repeat(64)]) {
      res = await upload(base, jpeg, { deviceId: good });
      assert.equal(res.status, 201, `qurilma ID: ${good}`);
    }
  });
});

test('X-Uptime-Ms noto\'g\'ri bo\'lsa 400', async () => {
  const jpeg = await solidJpeg();
  await withServer({}, async ({ base }) => {
    for (const bad of ['abc', '-5', '1.5', '12e3', '9'.repeat(16)]) {
      const res = await upload(base, jpeg, { uptime: bad });
      assert.equal(res.status, 400, `uptime: ${bad}`);
      assert.equal(res.json.error, 'invalid_uptime');
    }
  });
});

test('Content-Type image/jpeg bo\'lmasa 415', async () => {
  const jpeg = await solidJpeg();
  await withServer({}, async ({ base }) => {
    for (const contentType of ['text/plain', 'application/json', 'multipart/form-data; boundary=x', 'image/png']) {
      const res = await upload(base, jpeg, { contentType });
      assert.equal(res.status, 415, contentType);
      assert.equal(res.json.error, 'unsupported_media_type');
    }
  });
});

test('GET /upload 405 va Allow: POST', async () => {
  await withServer({}, async ({ base }) => {
    const res = await getJson(base, '/upload');
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    assert.equal(res.json.error, 'method_not_allowed');
  });
});

// ---------------------------------------------------------------- qurilma va RAM limitlari

test('uchinchi qurilma 409 device_limit_reached, mavjud qurilmalar ishlaydi', async () => {
  const jpeg = await solidJpeg();
  await withServer({}, async ({ base }) => {
    assert.equal((await upload(base, jpeg, { deviceId: 'CAM-A' })).status, 201);
    assert.equal((await upload(base, jpeg, { deviceId: 'CAM-B' })).status, 201);
    const third = await upload(base, jpeg, { deviceId: 'CAM-C' });
    assert.equal(third.status, 409);
    assert.equal(third.json.error, 'device_limit_reached');
    assert.equal((await upload(base, jpeg, { deviceId: 'CAM-A' })).status, 201);
    const devices = await getJson(base, '/api/devices');
    assert.deepEqual(devices.json.devices.map((d) => d.device_id).sort(), ['CAM-A', 'CAM-B']);
  });
});

test('RAMdagi eski rasmlar o\'chiriladi: qurilma uchun oxirgi N ta', async () => {
  const jpegs = await Promise.all([1, 2, 3, 4, 5].map((i) => solidJpeg(64, 48, { r: i * 40, g: 20, b: 20 })));
  await withServer({ storeOptions: { maxImagesPerDevice: 3 } }, async ({ base }) => {
    const ids = [];
    for (const jpeg of jpegs) {
      const res = await upload(base, jpeg);
      assert.equal(res.status, 201);
      ids.push(res.json.image_id);
    }
    const list = await getJson(base, '/api/images?device_id=TRAKTOR-CAM-01');
    assert.deepEqual(list.json.images.map((i) => i.image_id), [ids[4], ids[3], ids[2]]);

    for (const evicted of ids.slice(0, 2)) {
      const res = await fetch(`${base}/images/${evicted}`);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error, 'image_not_found');
    }
    assert.equal((await fetch(`${base}/images/${ids[4]}`)).status, 200);
  });
});

test('RAMdagi eski rasmlar o\'chiriladi: umumiy bayt limiti', async () => {
  const jpegs = await Promise.all([1, 2, 3, 4].map((i) => noiseJpeg(40 + i, 30)));
  const sizes = jpegs.map((j) => j.length);
  const limit = sizes[2] + sizes[3] + 1; // faqat oxirgi ikkitasi sig'adi
  await withServer({ storeOptions: { maxTotalBytes: limit } }, async ({ base, store }) => {
    const ids = [];
    for (const jpeg of jpegs) {
      const res = await upload(base, jpeg);
      assert.equal(res.status, 201);
      ids.push(res.json.image_id);
      assert.ok(store.stats().totalBytes <= limit, 'umumiy hajm limitdan oshmasligi kerak');
    }
    assert.equal((await fetch(`${base}/images/${ids[0]}`)).status, 404);
    assert.equal((await fetch(`${base}/images/${ids[1]}`)).status, 404);
    assert.equal((await fetch(`${base}/images/${ids[2]}`)).status, 200);
    assert.equal((await fetch(`${base}/images/${ids[3]}`)).status, 200);
    const list = await getJson(base, '/api/images?device_id=TRAKTOR-CAM-01');
    assert.equal(list.json.images.length, 2);
  });
});

test('bir vaqtdagi yuklashlar cheklovi: band bo\'lsa 503, bo\'shagach yana qabul qiladi', async () => {
  const jpeg = await solidJpeg();
  await withServer({ maxConcurrentUploads: 1 }, async ({ base, port }) => {
    // Birinchi mijoz sarlavhalarni yuboradi-yu, tanani to'liq yubormaydi: slot band qoladi.
    const hanging = net.connect(port, '127.0.0.1');
    hanging.write(
      'POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: image/jpeg\r\nX-Device-ID: SLOW\r\n' +
        `Content-Length: ${jpeg.length}\r\n\r\n`
    );
    hanging.write(jpeg.subarray(0, 10));
    await sleep(200);

    const busy = await upload(base, jpeg, { deviceId: 'FAST' });
    assert.equal(busy.status, 503);
    assert.equal(busy.json.error, 'server_busy');
    assert.equal(busy.headers.get('retry-after'), '5');

    hanging.destroy();
    let status = 0;
    for (let i = 0; i < 20 && status !== 201; i += 1) {
      await sleep(50);
      status = (await upload(base, jpeg, { deviceId: 'FAST' })).status;
    }
    assert.equal(status, 201, 'slot bo\'shatilgach yuklash qabul qilinishi kerak');
  });
});

// ---------------------------------------------------------------- o'qish endpointlari

test('GET /health', async () => {
  await withServer({}, async ({ base }) => {
    const res = await getJson(base, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.images, 0);
  });
});

test('rasm kelmagan holat: devices bo\'sh, latest 404 no_images, images bo\'sh ro\'yxat', async () => {
  await withServer({}, async ({ base }) => {
    const devices = await getJson(base, '/api/devices');
    assert.equal(devices.status, 200);
    assert.deepEqual(devices.json.devices, []);
    assert.equal(devices.json.limits.max_devices, 2);
    assert.equal(devices.json.limits.max_images_per_device, 10);
    assert.equal(devices.json.limits.max_total_bytes, 40 * 1024 * 1024);

    const latest = await getJson(base, '/api/latest');
    assert.equal(latest.status, 404);
    assert.equal(latest.json.error, 'no_images');

    const images = await getJson(base, '/api/images');
    assert.equal(images.status, 200);
    assert.deepEqual(images.json.images, []);
  });
});

test('noma\'lum yoki noto\'g\'ri device_id', async () => {
  const jpeg = await solidJpeg();
  await withServer({}, async ({ base }) => {
    await upload(base, jpeg, { deviceId: 'CAM-A' });
    for (const path of ['/api/latest', '/api/images']) {
      const unknown = await getJson(base, `${path}?device_id=NOPE`);
      assert.equal(unknown.status, 404, path);
      assert.equal(unknown.json.error, 'device_not_found');
      const invalid = await getJson(base, `${path}?device_id=bad%2Fid`);
      assert.equal(invalid.status, 400, path);
      assert.equal(invalid.json.error, 'invalid_device_id');
      const repeated = await getJson(base, `${path}?device_id=CAM-A&device_id=CAM-B`);
      assert.equal(repeated.status, 400, path);
    }
  });
});

test('latest, images va devices yuklangan rasmlarni aks ettiradi', async () => {
  const a1 = await solidJpeg(64, 48, { r: 10, g: 10, b: 10 });
  const a2 = await solidJpeg(80, 60, { r: 200, g: 10, b: 10 });
  const b1 = await solidJpeg(32, 24, { r: 10, g: 200, b: 10 });
  await withServer({}, async ({ base }) => {
    const r1 = await upload(base, a1, { deviceId: 'CAM-A', uptime: '1000' });
    const r2 = await upload(base, a2, { deviceId: 'CAM-A', uptime: '6000' });
    const r3 = await upload(base, b1, { deviceId: 'CAM-B', uptime: '500' });

    const latestA = await getJson(base, '/api/latest?device_id=CAM-A');
    assert.equal(latestA.status, 200);
    assert.equal(latestA.json.image.image_id, r2.json.image_id);
    assert.equal(latestA.json.image.bytes, a2.length);
    assert.ok(Number.isFinite(Date.parse(latestA.json.server_time)));

    // device_id ko'rsatilmasa — oxirgi rasm yuborgan qurilma
    const latestAny = await getJson(base, '/api/latest');
    assert.equal(latestAny.json.image.image_id, r3.json.image_id);

    const listA = await getJson(base, '/api/images?device_id=CAM-A');
    assert.deepEqual(listA.json.images.map((i) => i.image_id), [r2.json.image_id, r1.json.image_id]);
    assert.equal(listA.json.images[0].image_url, `/images/${r2.json.image_id}`);

    const devices = await getJson(base, '/api/devices');
    const byId = Object.fromEntries(devices.json.devices.map((d) => [d.device_id, d]));
    assert.equal(byId['CAM-A'].image_count, 2);
    assert.equal(byId['CAM-A'].latest_image_id, r2.json.image_id);
    assert.equal(byId['CAM-A'].last_uptime_ms, 6000);
    assert.equal(byId['CAM-B'].image_count, 1);
    assert.equal(devices.json.storage.images, 3);
    assert.equal(devices.json.storage.total_bytes, a1.length + a2.length + b1.length);
  });
});

test('GET /images/:id: noto\'g\'ri va mavjud bo\'lmagan ID 404; ?download=1 attachment', async () => {
  const jpeg = await solidJpeg();
  await withServer({}, async ({ base }) => {
    for (const id of ['zzz', '123', 'g'.repeat(24), 'a'.repeat(24)]) {
      const res = await fetch(`${base}/images/${id}`);
      assert.equal(res.status, 404, id);
      assert.equal((await res.json()).error, 'image_not_found');
    }
    const up = await upload(base, jpeg, { deviceId: 'CAM-A' });
    const dl = await fetch(`${base}/images/${up.json.image_id}?download=1`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'image/jpeg');
    const disposition = dl.headers.get('content-disposition');
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /CAM-A_\d{8}T\d{6}Z\.jpg/);
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('frontend fayllari beriladi va noma\'lum yo\'l JSON 404 qaytaradi', async () => {
  await withServer({}, async ({ base }) => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const html = await index.text();
    assert.match(html, /<html lang="uz">/);
    assert.match(html, /video emas/);
    assert.match(html, /yo'qoladi/); // RAM haqidagi ogohlantirish

    for (const [path, type] of [['/app.js', /javascript/], ['/style.css', /css/]]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), type);
    }

    const missing = await getJson(base, '/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'not_found');
    const missingApi = await getJson(base, '/api/nope');
    assert.equal(missingApi.status, 404);
    assert.equal(missingApi.json.ok, false);
  });
});

// ---------------------------------------------------------------- ishga tushirish

test('start(): 0.0.0.0 va PORT muhit o\'zgaruvchisi orqali tinglaydi', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const server = start({ PORT: String(port), API_TOKEN: 'x' });
  try {
    await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
    const address = server.address();
    assert.equal(address.address, '0.0.0.0');
    assert.equal(address.port, port);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
