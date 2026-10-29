'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ImageStore, StoreError } = require('../storage');

const img = (size, fill = 1) => Buffer.alloc(size, fill);

test('har bir qurilma uchun faqat oxirgi 10 ta rasm saqlanadi', () => {
  const store = new ImageStore();
  const ids = [];
  for (let i = 0; i < 13; i += 1) {
    ids.push(store.add('CAM-1', img(100, i)).id);
  }
  const list = store.list('CAM-1');
  assert.equal(list.length, 10);
  assert.equal(list[0].id, ids[12], 'eng yangisi birinchi bo\'lishi kerak');
  assert.equal(list[9].id, ids[3]);
  for (const evicted of ids.slice(0, 3)) assert.equal(store.get(evicted), undefined);
  assert.equal(store.getLatest('CAM-1').id, ids[12]);
});

test('uchinchi qurilma rad etiladi, mavjudlari ishlashda davom etadi', () => {
  const store = new ImageStore({ maxDevices: 2 });
  store.add('A', img(10));
  store.add('B', img(10));
  assert.throws(
    () => store.add('C', img(10)),
    (err) => err instanceof StoreError && err.code === 'device_limit_reached'
  );
  assert.doesNotThrow(() => store.add('A', img(10)));
  assert.equal(store.devices().length, 2);
});

test('umumiy RAM limiti oshganda eng eski rasmlar o\'chiriladi', () => {
  const store = new ImageStore({ maxTotalBytes: 1000, maxImagesPerDevice: 10 });
  const first = store.add('A', img(400));
  const second = store.add('A', img(400));
  assert.equal(store.stats().totalBytes, 800);
  const third = store.add('A', img(400)); // 1200 > 1000 -> birinchisi o'chadi
  assert.equal(store.get(first.id), undefined);
  assert.ok(store.get(second.id));
  assert.ok(store.get(third.id));
  assert.equal(store.stats().totalBytes, 800);
  assert.ok(store.stats().totalBytes <= 1000);
});

test('umumiy limit qurilmalar bo\'yicha eng eski rasmni o\'chiradi', () => {
  const store = new ImageStore({ maxTotalBytes: 1000 });
  const a1 = store.add('A', img(400));
  const b1 = store.add('B', img(400));
  const a2 = store.add('A', img(400)); // butun ombordagi eng eski: a1
  assert.equal(store.get(a1.id), undefined);
  assert.ok(store.get(b1.id));
  assert.ok(store.get(a2.id));
  assert.equal(store.list('A').length, 1);
  assert.equal(store.list('B').length, 1);
});

test('yangi rasm hech qachon o\'zi tomonidan o\'chirilmaydi', () => {
  const store = new ImageStore({ maxTotalBytes: 500 });
  const big = store.add('A', img(500));
  assert.ok(store.get(big.id));
  const next = store.add('A', img(500));
  assert.equal(store.get(big.id), undefined);
  assert.ok(store.get(next.id));
  assert.equal(store.stats().totalBytes, 500);
});

test('umumiy limitdan katta rasm rad etiladi', () => {
  const store = new ImageStore({ maxTotalBytes: 100 });
  assert.throws(
    () => store.add('A', img(101)),
    (err) => err instanceof StoreError && err.code === 'image_larger_than_store'
  );
  assert.equal(store.devices().length, 0, 'rad etilgan rasm qurilmani ro\'yxatga qo\'shmasligi kerak');
});

test('bo\'sh buffer rad etiladi', () => {
  const store = new ImageStore();
  assert.throws(() => store.add('A', Buffer.alloc(0)), (err) => err.code === 'empty_image');
});

test('qurilmalar ro\'yxati va statistika', () => {
  const store = new ImageStore();
  store.add('A', img(10), { uptimeMs: 5, receivedAt: '2026-01-01T00:00:00.000Z' });
  const last = store.add('A', img(20), { uptimeMs: 9, width: 4, height: 3, receivedAt: '2026-01-01T00:00:05.000Z' });
  const [device] = store.devices();
  assert.equal(device.deviceId, 'A');
  assert.equal(device.imageCount, 2);
  assert.equal(device.lastSeenAt, '2026-01-01T00:00:05.000Z');
  assert.equal(device.lastUptimeMs, 9);
  assert.equal(device.latestImageId, last.id);
  assert.equal(device.latestBytes, 20);
  assert.deepEqual(store.stats().limits, { maxDevices: 2, maxImagesPerDevice: 10, maxTotalBytes: 40 * 1024 * 1024 });
  assert.equal(store.mostRecentDeviceId(), 'A');
});

test('mostRecentDeviceId eng oxirgi rasm yuborgan qurilmani qaytaradi', () => {
  const store = new ImageStore();
  assert.equal(store.mostRecentDeviceId(), undefined);
  store.add('A', img(10));
  store.add('B', img(10));
  assert.equal(store.mostRecentDeviceId(), 'B');
  store.add('A', img(10));
  assert.equal(store.mostRecentDeviceId(), 'A');
});

test('standart limitlar: 2 qurilma, 10 rasm, 40 MB', () => {
  const store = new ImageStore();
  assert.equal(store.maxDevices, 2);
  assert.equal(store.maxImagesPerDevice, 10);
  assert.equal(store.maxTotalBytes, 40 * 1024 * 1024);
});
