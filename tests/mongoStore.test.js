'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoStore } = require('../mongoStore');
const { StoreError } = require('../storeCommon');

function createMockDb() {
  const devices = new Map();
  const images = [];

  const devicesCol = {
    async createIndex() {},
    async findOne(query) {
      if (query._id) return devices.get(query._id) || null;
      return null;
    },
    async insertOne(doc) {
      devices.set(doc._id, { ...doc });
    },
    async updateOne(query, update) {
      const doc = devices.get(query._id);
      if (!doc) return;
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          doc[k] = (doc[k] || 0) + v;
        }
      }
    },
    async countDocuments(query = {}) {
      if (query._id) return devices.has(query._id) ? 1 : 0;
      return devices.size;
    },
    find() {
      return {
        async toArray() {
          return Array.from(devices.values());
        },
      };
    },
  };

  const imagesCol = {
    async createIndex() {},
    async insertOne(doc) {
      images.push({ ...doc });
    },
    async findOne(query) {
      return images.find((img) => img._id === query._id) || null;
    },
    find(filter = {}, options = {}) {
      let filtered = images.filter((img) => {
        if (filter.deviceId && img.deviceId !== filter.deviceId) return false;
        if (filter._id && filter._id.$ne && img._id === filter._id.$ne) return false;
        return true;
      });

      return {
        sort() {
          return this;
        },
        skip(n) {
          filtered = filtered.slice(n);
          return this;
        },
        limit(n) {
          filtered = filtered.slice(0, n);
          return this;
        },
        async toArray() {
          return filtered;
        },
        async next() {
          return filtered[0] || null;
        },
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            async next() {
              if (idx < filtered.length) {
                return { value: filtered[idx++], done: false };
              }
              return { done: true };
            },
          };
        },
      };
    },
    async deleteMany(query) {
      if (query._id && query._id.$in) {
        const idSet = new Set(query._id.$in);
        for (let i = images.length - 1; i >= 0; i--) {
          if (idSet.has(images[i]._id)) images.splice(i, 1);
        }
      }
    },
    async deleteOne(query) {
      const idx = images.findIndex((img) => img._id === query._id);
      if (idx !== -1) images.splice(idx, 1);
    },
    async countDocuments() {
      return images.length;
    },
    aggregate() {
      return {
        async toArray() {
          const totalBytes = images.reduce((sum, img) => sum + img.bytes, 0);
          return [{ _id: null, totalBytes }];
        },
      };
    },
  };

  const mockClient = {
    db() {
      return {
        collection(name) {
          if (name === 'devices') return devicesCol;
          if (name === 'images') return imagesCol;
          throw new Error('Unknown collection: ' + name);
        },
      };
    },
    async close() {},
  };

  return { mockClient, devices, images };
}

const sampleBuf = (size = 100) => Buffer.alloc(size, 0x42);

test('MongoStore: rasm saqlash, olish va ro\'yxat', async () => {
  const { mockClient } = createMockDb();
  const store = new MongoStore({ client: mockClient });

  const record = await store.add('CAM-1', sampleBuf(120), { uptimeMs: 5000 });
  assert.equal(record.deviceId, 'CAM-1');
  assert.equal(record.bytes, 120);
  assert.equal(record.uptimeMs, 5000);
  assert.match(record.id, /^[a-f0-9]{24}$/);

  const latest = await store.getLatest('CAM-1');
  assert.equal(latest.id, record.id);
  assert.equal(latest.deviceId, 'CAM-1');

  const fullImg = await store.get(record.id);
  assert.ok(fullImg);
  assert.equal(fullImg.id, record.id);
  assert.equal(fullImg.buffer.length, 120);

  const devList = await store.devices();
  assert.equal(devList.length, 1);
  assert.equal(devList[0].deviceId, 'CAM-1');
  assert.equal(devList[0].imageCount, 1);

  const stats = await store.stats();
  assert.equal(stats.devices, 1);
  assert.equal(stats.images, 1);
  assert.equal(stats.totalBytes, 120);

  await store.close();
});

test('MongoStore: maxDevices limiti oshganda StoreError tashlaydi', async () => {
  const { mockClient } = createMockDb();
  const store = new MongoStore({ client: mockClient, maxDevices: 2 });

  await store.add('CAM-1', sampleBuf(50));
  await store.add('CAM-2', sampleBuf(50));

  await assert.rejects(
    async () => {
      await store.add('CAM-3', sampleBuf(50));
    },
    (err) => err instanceof StoreError && err.code === 'device_limit_reached'
  );
});

test('MongoStore: bo\'sh rasm yoki limitdan katta rasm rad etiladi', async () => {
  const { mockClient } = createMockDb();
  const store = new MongoStore({ client: mockClient, maxTotalBytes: 500 });

  await assert.rejects(
    async () => {
      await store.add('CAM-1', Buffer.alloc(0));
    },
    (err) => err instanceof StoreError && err.code === 'empty_image'
  );

  await assert.rejects(
    async () => {
      await store.add('CAM-1', sampleBuf(501));
    },
    (err) => err instanceof StoreError && err.code === 'image_larger_than_store'
  );
});
