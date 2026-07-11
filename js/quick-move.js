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
      originalName: image.name,
      originalFolderPath: image.folderPath,
      originalParentDirectoryHandle: image.parentDirectoryHandle,
      status: "pending",
      error: null,
    }));
    this.cursor = 0;
    this.busy = false;
    this.history = [];
  }

  get currentEntry() {
    return this.entries[this.cursor] || null;
  }

  completeCurrent(status, error = null) {
    const entry = this.currentEntry;
    if (!entry || entry.status !== "pending") return null;
    entry.status = status;
    entry.error = error;
    this.history.push(this.cursor);
    this.advance();
    return entry;
  }

  get lastCompletedEntry() {
    const index = this.history[this.history.length - 1];
    return Number.isInteger(index) ? this.entries[index] : null;
  }

  reopenLastCompleted() {
    const index = this.history.pop();
    if (!Number.isInteger(index)) return null;
    const entry = this.entries[index];
    entry.status = "pending";
    entry.error = null;
    this.cursor = index;
    return entry;
  }

  get canUndo() {
    return this.history.length > 0;
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
