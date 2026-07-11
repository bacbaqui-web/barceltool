(function initializeMasonryModule() {
"use strict";

class MasonryLayout {
  constructor({ minColumnWidth = 220, gap = 14, padding = 18, maxColumns = 6 } = {}) {
    this.minColumnWidth = minColumnWidth;
    this.gap = gap;
    this.padding = padding;
    this.maxColumns = maxColumns;
    this.positions = [];
    this.totalHeight = 0;
  }

  calculate(items, containerWidth, requestedColumnCount = null) {
    const usableWidth = Math.max(1, containerWidth - this.padding * 2);
    const responsiveColumns = usableWidth >= 1500 ? 6
      : usableWidth >= 1100 ? 5
        : usableWidth >= 800 ? 4
          : usableWidth >= 620 ? 3
            : usableWidth >= 420 ? 2
              : 1;
    const columnCount = requestedColumnCount === null
      ? Math.min(this.maxColumns, responsiveColumns)
      : Math.max(1, Math.round(requestedColumnCount));
    const columnWidth = (usableWidth - this.gap * (columnCount - 1)) / columnCount;
    const columnHeights = new Array(columnCount).fill(this.padding);

    this.positions = items.map((item, index) => {
      const ratio = item.naturalWidth > 0 && item.naturalHeight > 0
        ? item.naturalHeight / item.naturalWidth
        : 1;
      const naturalHeight = Math.max(80, Math.round(columnWidth * ratio));
      const maximumThumbnailHeight = Math.round(columnWidth * 3);
      const isTruncated = naturalHeight > maximumThumbnailHeight;
      const height = Math.min(naturalHeight, maximumThumbnailHeight);
      let shortestColumn = 0;
      for (let column = 1; column < columnCount; column += 1) {
        if (columnHeights[column] < columnHeights[shortestColumn]) shortestColumn = column;
      }
      const position = {
        index,
        column: shortestColumn,
        x: this.padding + shortestColumn * (columnWidth + this.gap),
        y: columnHeights[shortestColumn],
        width: columnWidth,
        height,
        isTruncated,
      };
      columnHeights[shortestColumn] += height + this.gap;
      return position;
    });

    this.totalHeight = items.length
      ? Math.max(...columnHeights) - this.gap + this.padding
      : 0;
    return { positions: this.positions, totalHeight: this.totalHeight, columnCount };
  }

  updateMeasuredItems(items, changedIndexes) {
    if (this.positions.length !== items.length || !changedIndexes.length) return null;
    const changedColumns = new Set();
    changedIndexes.forEach((index) => {
      const position = this.positions[index];
      if (position) changedColumns.add(position.column);
    });
    changedColumns.forEach((column) => {
      const columnPositions = this.positions.filter((position) => position.column === column);
      let nextY = this.padding;
      columnPositions.forEach((position) => {
        const item = items[position.index];
        const ratio = item.naturalWidth > 0 && item.naturalHeight > 0
          ? item.naturalHeight / item.naturalWidth
          : 1;
        const naturalHeight = Math.max(80, Math.round(position.width * ratio));
        const maximumThumbnailHeight = Math.round(position.width * 3);
        position.y = nextY;
        position.height = Math.min(naturalHeight, maximumThumbnailHeight);
        position.isTruncated = naturalHeight > maximumThumbnailHeight;
        nextY += position.height + this.gap;
      });
    });
    this.totalHeight = this.positions.length
      ? Math.max(...this.positions.map((position) => position.y + position.height)) + this.padding
      : 0;
    return { positions: this.positions, totalHeight: this.totalHeight, changedColumns };
  }
}

class VirtualRenderer {
  constructor({
    scrollElement,
    canvasElement,
    createCard,
    updateCard,
    onImageNeeded,
    onPrefetchSet,
    buffer = 1200,
    forwardPrefetch = 4000,
    backwardPrefetch = 1500,
    maxPrefetch = 300,
    maxNodes = 150,
  }) {
    this.scrollElement = scrollElement;
    this.canvasElement = canvasElement;
    this.createCard = createCard;
    this.updateCard = updateCard;
    this.onImageNeeded = onImageNeeded;
    this.onPrefetchSet = onPrefetchSet;
    this.buffer = buffer;
    this.forwardPrefetch = forwardPrefetch;
    this.backwardPrefetch = backwardPrefetch;
    this.maxPrefetch = maxPrefetch;
    this.maxNodes = maxNodes;
    this.items = [];
    this.positions = [];
    this.rendered = new Map();
    this.renderedItems = new Map();
    this.pool = [];
    this.spatialBuckets = new Map();
    this.bucketSize = 600;
    this.frameId = 0;
    this.lastScrollTop = 0;
    this.scrollDirection = "down";
    this.imageObserver = new IntersectionObserver(
      (entries) => this.handleIntersections(entries),
      { root: scrollElement, rootMargin: "600px 0px" },
    );
    this.handleScroll = () => this.scheduleRender();
    scrollElement.addEventListener("scroll", this.handleScroll, { passive: true });
  }

  setData(items, positions, totalHeight) {
    this.recycleAll();
    this.items = items;
    this.positions = positions;
    this.lastScrollTop = this.scrollElement.scrollTop;
    this.scrollDirection = "down";
    this.buildSpatialIndex();
    this.canvasElement.style.height = `${Math.max(0, totalHeight)}px`;
    this.scheduleRender();
  }

  updateLayout(items, positions, totalHeight) {
    this.items = items;
    this.positions = positions;
    this.buildSpatialIndex();
    this.canvasElement.style.height = `${Math.max(0, totalHeight)}px`;
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.frameId) return;
    this.frameId = requestAnimationFrame(() => {
      this.frameId = 0;
      this.renderVisibleRange();
    });
  }

  renderVisibleRange() {
    const viewportTop = this.scrollElement.scrollTop;
    this.scrollDirection = viewportTop >= this.lastScrollTop ? "down" : "up";
    this.lastScrollTop = viewportTop;
    const viewportBottom = viewportTop + this.scrollElement.clientHeight;
    const rangeTop = Math.max(0, viewportTop - this.buffer);
    const rangeBottom = viewportBottom + this.buffer;
    const candidateIndexes = new Set();
    const firstBucket = Math.floor(rangeTop / this.bucketSize);
    const lastBucket = Math.floor(rangeBottom / this.bucketSize);
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      this.spatialBuckets.get(bucket)?.forEach((index) => candidateIndexes.add(index));
    }
    let required = [...candidateIndexes]
      .map((index) => this.positions[index])
      .filter((position) => position.y + position.height >= rangeTop && position.y <= rangeBottom);

    if (required.length > this.maxNodes) {
      const viewportCenter = (viewportTop + viewportBottom) / 2;
      required = required
        .sort((a, b) => Math.abs(a.y + a.height / 2 - viewportCenter) - Math.abs(b.y + b.height / 2 - viewportCenter))
        .slice(0, this.maxNodes);
    }

    const requiredIndexes = new Set(required.map((position) => position.index));
    for (const [index, card] of this.rendered) {
      if (!requiredIndexes.has(index)) this.recycleCard(index, card);
    }
    required.forEach((position) => {
      let card = this.rendered.get(position.index);
      if (!card) {
        card = this.pool.pop() || this.createCard();
        this.rendered.set(position.index, card);
        this.canvasElement.appendChild(card);
      }
      this.positionCard(card, position);
      this.updateCard(card, this.items[position.index], position.index);
      this.renderedItems.set(position.index, this.items[position.index]);
      this.onImageNeeded?.(
        this.items[position.index],
        this.getLoadPriority(position, viewportTop, viewportBottom),
      );
      const image = card.querySelector("img");
      if (image && !image.hasAttribute("src")) this.imageObserver.observe(image);
    });
    this.prefetchNearby(viewportTop, viewportBottom, required.map((position) => this.items[position.index]));
  }

  prefetchNearby(viewportTop, viewportBottom, requiredItems = []) {
    const rangeTop = Math.max(0, viewportTop - (this.scrollDirection === "up" ? this.forwardPrefetch : this.backwardPrefetch));
    const rangeBottom = viewportBottom + (this.scrollDirection === "down" ? this.forwardPrefetch : this.backwardPrefetch);
    const indexes = new Set();
    const firstBucket = Math.floor(rangeTop / this.bucketSize);
    const lastBucket = Math.floor(rangeBottom / this.bucketSize);
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      this.spatialBuckets.get(bucket)?.forEach((index) => indexes.add(index));
    }
    const center = this.scrollDirection === "down" ? viewportBottom : viewportTop;
    const positions = [...indexes]
      .map((index) => this.positions[index])
      .filter((position) => position && position.y + position.height >= rangeTop && position.y <= rangeBottom)
      .sort((left, right) => Math.abs(left.y - center) - Math.abs(right.y - center))
      .slice(0, this.maxPrefetch);
    const items = [...new Set([
      ...requiredItems,
      ...positions.map((position) => this.items[position.index]).filter(Boolean),
    ])];
    this.onPrefetchSet?.(items);
    positions.forEach((position) => {
      this.onImageNeeded?.(this.items[position.index], this.getLoadPriority(position, viewportTop, viewportBottom));
    });
  }

  refreshRenderedCards() {
    for (const [index, card] of this.rendered) {
      this.updateCard(card, this.items[index], index);
      const image = card.querySelector("img");
      if (image?.dataset.intersecting === "true" && image.dataset.src && !image.hasAttribute("src")) {
        image.src = image.dataset.src;
      }
    }
  }

  getRenderedItems() {
    return new Set([...this.renderedItems.values()].filter(Boolean));
  }

  getLoadPriority(position, viewportTop, viewportBottom) {
    const bottom = position.y + position.height;
    if (bottom >= viewportTop && position.y <= viewportBottom) return 0;
    if (position.y > viewportBottom && position.y <= viewportBottom + 500) return 1;
    if (bottom < viewportTop && bottom >= viewportTop - 500) return 2;
    const followsDirection = this.scrollDirection === "down" ? position.y > viewportBottom : bottom < viewportTop;
    return followsDirection ? 3 : 4;
  }

  buildSpatialIndex() {
    this.spatialBuckets.clear();
    this.positions.forEach((position) => {
      const firstBucket = Math.floor(position.y / this.bucketSize);
      const lastBucket = Math.floor((position.y + position.height) / this.bucketSize);
      for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
        if (!this.spatialBuckets.has(bucket)) this.spatialBuckets.set(bucket, []);
        this.spatialBuckets.get(bucket).push(position.index);
      }
    });
  }

  positionCard(card, position) {
    card.style.width = `${position.width}px`;
    card.style.height = `${position.height}px`;
    card.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
  }

  handleIntersections(entries) {
    entries.forEach((entry) => {
      const image = entry.target;
      image.dataset.intersecting = String(entry.isIntersecting);
      if (!entry.isIntersecting) return;
      const index = Number(image.closest(".thumbnail-card")?.dataset.index);
      if (Number.isInteger(index)) this.onImageNeeded?.(this.items[index], 0);
      if (image.dataset.src && image.src !== image.dataset.src) image.src = image.dataset.src;
    });
  }

  recycleCard(index, card) {
    const image = card.querySelector("img");
    if (image) {
      this.imageObserver.unobserve(image);
      image.removeAttribute("src");
      image.removeAttribute("data-src");
      image.removeAttribute("data-intersecting");
    }
    card.remove();
    this.rendered.delete(index);
    this.renderedItems.delete(index);
    this.pool.push(card);
  }

  recycleAll() {
    for (const [index, card] of [...this.rendered]) this.recycleCard(index, card);
  }

  destroy() {
    cancelAnimationFrame(this.frameId);
    this.scrollElement.removeEventListener("scroll", this.handleScroll);
    this.imageObserver.disconnect();
    this.recycleAll();
    this.pool.length = 0;
  }
}

class ImageLoadQueue {
  constructor({ loader, onLoaded, onDiscarded, concurrency = 4 }) {
    this.loader = loader;
    this.onLoaded = onLoaded;
    this.onDiscarded = onDiscarded;
    this.concurrency = concurrency;
    this.pending = new Map();
    this.active = 0;
    this.generation = 0;
  }

  enqueue(item, priority = 4) {
    if (!item || item.objectUrl && item.naturalWidth && item.naturalHeight) return Promise.resolve(item);
    const existing = this.pending.get(item);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise;
    }
    if (item.loadPromise) return item.loadPromise;
    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    item.loadPromise = promise;
    this.pending.set(item, { item, priority, promise, resolveTask, rejectTask, generation: this.generation });
    this.pump();
    return promise;
  }

  get busy() {
    return this.active > 0 || this.pending.size > 0;
  }

  clear() {
    this.generation += 1;
    for (const task of this.pending.values()) {
      task.item.loadPromise = null;
      task.resolveTask(task.item);
    }
    this.pending.clear();
  }

  retain(items, maximumProtectedPriority = -1) {
    const retained = new Set(items);
    for (const [item, task] of this.pending) {
      if (task.priority <= maximumProtectedPriority || retained.has(task.item)) continue;
      this.pending.delete(item);
      task.item.loadPromise = null;
      task.resolveTask(task.item);
    }
  }

  pump() {
    while (this.active < this.concurrency && this.pending.size) {
      const task = [...this.pending.values()].sort((a, b) => a.priority - b.priority)[0];
      this.pending.delete(task.item);
      this.active += 1;
      this.loader(task.item)
        .then((item) => {
          if (task.generation === this.generation) this.onLoaded?.(item);
          else this.onDiscarded?.(item);
          task.resolveTask(item);
        })
        .catch((error) => task.rejectTask(error))
        .finally(() => { task.item.loadPromise = null; this.active -= 1; this.pump(); });
    }
  }
}

window.BarcelMasonry = { ImageLoadQueue, MasonryLayout, VirtualRenderer };
})();
