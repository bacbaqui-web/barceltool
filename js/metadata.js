(function initializeMetadataModule() {
"use strict";

class MetadataCache {
  constructor({ databaseName = "barceltool-metadata", storeName = "images" } = {}) {
    this.databaseName = databaseName;
    this.storeName = storeName;
    this.databasePromise = null;
  }

  open() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.createObjectStore(this.storeName, { keyPath: "key" });
        store.createIndex("rootName", "rootName", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return this.databasePromise;
  }

  async loadRoot(rootName) {
    const database = await this.open();
    if (!database) return new Map();
    return new Promise((resolve) => {
      const transaction = database.transaction(this.storeName, "readonly");
      const request = transaction.objectStore(this.storeName).index("rootName").getAll(rootName);
      request.onsuccess = () => resolve(new Map(request.result.map((record) => [record.relativePath, record])));
      request.onerror = () => resolve(new Map());
    });
  }

  async put(rootName, image) {
    const database = await this.open();
    if (!database || !image.lastModified || !image.fileSize || !image.naturalWidth || !image.naturalHeight) return;
    const record = {
      key: `${rootName}\u0000${image.relativePath}`,
      rootName,
      relativePath: image.relativePath,
      lastModified: image.lastModified,
      fileSize: image.fileSize,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
    await new Promise((resolve) => {
      const transaction = database.transaction(this.storeName, "readwrite");
      transaction.objectStore(this.storeName).put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }
}

class BackgroundMetadataIndexer {
  constructor({ loader, onItem, onProgress, onComplete, shouldPause, concurrency = 1 } = {}) {
    this.loader = loader;
    this.onItem = onItem;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.shouldPause = shouldPause;
    this.concurrency = Math.max(1, concurrency);
    this.generation = 0;
    this.items = [];
    this.cursor = 0;
    this.processed = 0;
    this.failed = 0;
    this.lastProgressAt = 0;
  }

  start(items, context = null) {
    this.clear();
    const generation = this.generation;
    this.items = items.slice();
    this.context = context;
    this.cursor = 0;
    this.processed = 0;
    this.failed = 0;
    this.reportProgress(true);
    for (let worker = 0; worker < this.concurrency; worker += 1) this.runWorker(generation);
  }

  clear() {
    this.generation += 1;
    this.items = [];
    this.cursor = 0;
  }

  async runWorker(generation) {
    while (generation === this.generation) {
      const index = this.cursor;
      this.cursor += 1;
      if (index >= this.items.length) break;
      await this.waitForIdle(generation);
      if (generation !== this.generation) return;
      const item = this.items[index];
      try {
        await this.loader(item, this.context);
        if (generation !== this.generation) return;
        this.onItem?.(item);
      } catch {
        if (generation !== this.generation) return;
        this.failed += 1;
      }
      this.processed += 1;
      this.reportProgress();
    }
    if (generation === this.generation && this.processed >= this.items.length) {
      this.reportProgress(true);
      this.onComplete?.({ total: this.items.length, failed: this.failed });
    }
  }

  async waitForIdle(generation) {
    while (generation === this.generation && this.shouldPause?.()) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (generation !== this.generation) return;
    await new Promise((resolve) => {
      if ("requestIdleCallback" in window) requestIdleCallback(() => resolve(), { timeout: 500 });
      else setTimeout(resolve, 16);
    });
  }

  reportProgress(force = false) {
    const now = performance.now();
    if (!force && now - this.lastProgressAt < 80 && this.processed < this.items.length) return;
    this.lastProgressAt = now;
    this.onProgress?.({ processed: this.processed, total: this.items.length, failed: this.failed });
  }
}

class ImageResourceCache {
  constructor({ maxEntries = 500, maxBytes = 512 * 1024 * 1024, getProtectedItems, onEvicted } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.getProtectedItems = getProtectedItems;
    this.onEvicted = onEvicted;
    this.entries = new Map();
    this.totalBytes = 0;
  }

  touch(image) {
    if (!image?.objectUrl) return;
    const alreadyCached = this.entries.has(image);
    this.entries.delete(image);
    this.entries.set(image, true);
    if (!alreadyCached) this.totalBytes += image.fileSize || image.file?.size || 0;
    this.prune();
  }

  remove(image, revoke = true) {
    if (this.entries.delete(image)) this.totalBytes = Math.max(0, this.totalBytes - (image.fileSize || image.file?.size || 0));
    if (!image) return;
    if (revoke && image.objectUrl) URL.revokeObjectURL(image.objectUrl);
    image.objectUrl = null;
    image.file = null;
  }

  clear({ revoke = true } = {}) {
    for (const image of this.entries.keys()) this.remove(image, revoke);
    this.entries.clear();
    this.totalBytes = 0;
  }

  prune() {
    if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return;
    const protectedItems = this.getProtectedItems?.() || new Set();
    let evicted = false;
    for (const image of [...this.entries.keys()]) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      if (protectedItems.has(image) || image.loadPromise) continue;
      this.remove(image, true);
      evicted = true;
    }
    if (evicted) this.onEvicted?.();
  }
}

async function readImageDimensionsFromHeader(file, extension) {
  const type = extension.toLowerCase();
  if (type === "svg") return readSvgDimensions(file);
  const buffer = await file.slice(0, Math.min(file.size, 262144)).arrayBuffer();
  const view = new DataView(buffer);
  if (type === "png" && view.byteLength >= 24
    && view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type === "gif" && view.byteLength >= 10
    && view.getUint8(0) === 0x47 && view.getUint8(1) === 0x49 && view.getUint8(2) === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (type === "bmp" && view.byteLength >= 26 && view.getUint16(0) === 0x424D) {
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if ((type === "jpg" || type === "jpeg") && view.byteLength >= 4) return readJpegDimensions(view);
  if (type === "webp" && view.byteLength >= 30) return readWebpDimensions(view);
  return null;
}

function readJpegDimensions(view) {
  if (view.getUint16(0) !== 0xFFD8) return null;
  let offset = 2;
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xFF) { offset += 1; continue; }
    const marker = view.getUint8(offset + 1);
    if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    const isStartOfFrame = marker >= 0xC0 && marker <= 0xC3
      || marker >= 0xC5 && marker <= 0xC7
      || marker >= 0xC9 && marker <= 0xCB
      || marker >= 0xCD && marker <= 0xCF;
    if (isStartOfFrame && offset + 8 < view.byteLength) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return null;
}

function readWebpDimensions(view) {
  const text = (offset, length) => String.fromCharCode(...new Uint8Array(view.buffer, offset, length));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WEBP") return null;
  const chunk = text(12, 4);
  if (chunk === "VP8X") {
    return { width: 1 + readUint24(view, 24), height: 1 + readUint24(view, 27) };
  }
  if (chunk === "VP8L" && view.getUint8(20) === 0x2F) {
    const b1 = view.getUint8(21); const b2 = view.getUint8(22);
    const b3 = view.getUint8(23); const b4 = view.getUint8(24);
    return {
      width: 1 + (((b2 & 0x3F) << 8) | b1),
      height: 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | ((b2 & 0xC0) >> 6)),
    };
  }
  if (chunk === "VP8 ") {
    for (let offset = 20; offset + 9 < view.byteLength; offset += 1) {
      if (view.getUint8(offset + 3) === 0x9D && view.getUint8(offset + 4) === 0x01 && view.getUint8(offset + 5) === 0x2A) {
        return { width: view.getUint16(offset + 6, true) & 0x3FFF, height: view.getUint16(offset + 8, true) & 0x3FFF };
      }
    }
  }
  return null;
}

function readUint24(view, offset) {
  return view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16;
}

async function readSvgDimensions(file) {
  const text = await file.slice(0, Math.min(file.size, 65536)).text();
  const svgTag = text.match(/<svg\b[^>]*>/i)?.[0];
  if (!svgTag) return null;
  const numericAttribute = (name) => {
    const match = svgTag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']\\s*([0-9.]+)`, "i"));
    return match ? Number(match[1]) : 0;
  };
  const width = numericAttribute("width");
  const height = numericAttribute("height");
  if (width > 0 && height > 0) return { width, height };
  const viewBox = svgTag.match(/viewBox\s*=\s*["']\s*[-0-9.]+[ ,]+[-0-9.]+[ ,]+([0-9.]+)[ ,]+([0-9.]+)/i);
  return viewBox ? { width: Number(viewBox[1]), height: Number(viewBox[2]) } : null;
}

window.BarcelMetadata = {
  BackgroundMetadataIndexer,
  ImageResourceCache,
  MetadataCache,
  readImageDimensionsFromHeader,
};
})();
