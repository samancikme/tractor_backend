'use strict';

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const DEFAULTS = Object.freeze({
  maxDevices: 2,
  maxImagesPerDevice: 10,
  maxTotalBytes: 40 * 1024 * 1024,
});

function positiveInt(value, fallback) {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

module.exports = { StoreError, DEFAULTS, positiveInt };
