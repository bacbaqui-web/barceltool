(function initializeQuickMoveModule() {
"use strict";

class QuickMoveSession {
  constructor(images, startIndex = 0) {
    const safeStart = images.length ? Math.max(0, Math.min(images.length - 1, startIndex)) : 0;
    const orderedImages = images.slice(safeStart).concat(images.slice(0, safeStart));
    this.entries = orderedImages.map((image, index) => ({
      id: `${index}:${image.relativePath}`,
      image,
      originalPath: image.relativePath,
      status: "pending",
      error: null,
    }));
    this.cursor = 0;
    this.busy = false;
  }

  get currentEntry() {
    return this.entries[this.cursor] || null;
  }

  completeCurrent(status, error = null) {
    const entry = this.currentEntry;
    if (!entry || entry.status !== "pending") return null;
    entry.status = status;
    entry.error = error;
    this.advance();
    return entry;
  }

  advance() {
    const nextIndex = this.entries.findIndex((entry, index) => index > this.cursor && entry.status === "pending");
    if (nextIndex >= 0) {
      this.cursor = nextIndex;
      return;
    }
    const wrappedIndex = this.entries.findIndex((entry) => entry.status === "pending");
    this.cursor = wrappedIndex >= 0 ? wrappedIndex : this.entries.length;
  }

  get stats() {
    const counts = { pending: 0, moved: 0, skipped: 0, failed: 0 };
    this.entries.forEach((entry) => { counts[entry.status] += 1; });
    return {
      total: this.entries.length,
      processed: this.entries.length - counts.pending,
      position: Math.min(this.cursor + 1, this.entries.length),
      ...counts,
    };
  }

  get complete() {
    return this.stats.pending === 0;
  }
}

window.BarcelQuickMove = { QuickMoveSession };
})();
