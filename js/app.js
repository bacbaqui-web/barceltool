(function initializeApp() {
"use strict";

const {
  copyThenRemove,
  createAvailableName,
  describeError,
  entryExists,
  findFolderNode,
  moveToTrash,
  permanentlyDelete,
  revokeImageUrls,
  scanDirectory,
  verifyPermission,
} = window.BarcelFileSystem;
const {
  closeModal,
  createElement,
  dismissModal,
  setModalActionEnabled,
  showModal,
  updateModalProgress,
} = window.BarcelModal;
const { ImageLoadQueue, MasonryLayout, VirtualRenderer } = window.BarcelMasonry;

const state = {
  rootDirectoryHandle: null,
  folderTree: null,
  images: [],
  trashImages: [],
  visibleImages: [],
  selectedFolderPath: "",
  viewingTrash: false,
  selectedPaths: new Set(),
  selectionAnchor: -1,
  previewIndex: -1,
  operationInProgress: false,
  dragPaths: [],
  trashCount: 0,
  dimensionLoadGeneration: 0,
  dimensionRelayoutTimer: 0,
  measuredImageIndexes: new Set(),
  keyboardOperationPending: false,
  columnCount: readSavedColumnCount(),
  scanning: false,
  previewWidth: readSavedPreviewWidth(),
  previewFitEnabled: readSavedPreviewFitEnabled(),
  previewVerticalFitEnabled: readSavedPreviewVerticalFitEnabled(),
};

const elements = {
  themeToggle: document.querySelector("#themeToggle"),
  openButtons: document.querySelectorAll('[data-action="open-folder"]'),
  refreshButton: document.querySelector("#refreshButton"),
  folderTree: document.querySelector("#folderTree"),
  trashSummary: document.querySelector("#trashSummary"),
  trashCount: document.querySelector("#trashCount"),
  contentPanel: document.querySelector("#contentPanel"),
  contentHeader: document.querySelector("#contentHeader"),
  statusText: document.querySelector("#statusText"),
  selectionCount: document.querySelector("#selectionCount"),
  columnSlider: document.querySelector("#columnSlider"),
  columnCount: document.querySelector("#columnCount"),
  moveButton: document.querySelector("#moveButton"),
  trashButton: document.querySelector("#trashButton"),
  imageGrid: document.querySelector("#imageGrid"),
  masonryCanvas: document.querySelector("#masonryCanvas"),
  emptyState: document.querySelector("#emptyState"),
  contextMenu: document.querySelector("#contextMenu"),
  previewOverlay: document.querySelector("#previewOverlay"),
  previewPath: document.querySelector("#previewPath"),
  previewFitEnabled: document.querySelector("#previewFitEnabled"),
  previewVerticalFitEnabled: document.querySelector("#previewVerticalFitEnabled"),
  previewWidthSlider: document.querySelector("#previewWidthSlider"),
  previewWidthValue: document.querySelector("#previewWidthValue"),
  previewBadge: document.querySelector("#previewBadge"),
  previewImage: document.querySelector("#previewImage"),
  previewCounter: document.querySelector("#previewCounter"),
  previewIndexLabel: document.querySelector("#previewIndexLabel"),
  previewFileName: document.querySelector("#previewFileName"),
  previewRenameButton: document.querySelector("#previewRenameButton"),
  modalOverlay: document.querySelector("#modalOverlay"),
};

const masonryLayout = new MasonryLayout({ minColumnWidth: 220, gap: 14, padding: 18, maxColumns: 6 });
const imageLoadQueue = new ImageLoadQueue({
  loader: loadImageResource,
  onLoaded: handleQueuedImageLoaded,
  onDiscarded: (image) => {
    if (image.objectUrl) URL.revokeObjectURL(image.objectUrl);
    image.objectUrl = null;
    image.file = null;
  },
  concurrency: 4,
});
const virtualRenderer = new VirtualRenderer({
  scrollElement: elements.imageGrid,
  canvasElement: elements.masonryCanvas,
  createCard: createThumbnailCard,
  updateCard: updateThumbnailCard,
  onImageNeeded: (image, priority) => imageLoadQueue.enqueue(image, priority).catch(() => {}),
  buffer: 1000,
  maxNodes: 150,
});
const galleryResizeObserver = new ResizeObserver(() => scheduleMasonryLayout());
galleryResizeObserver.observe(elements.imageGrid);

initializeTheme();
initializeColumnControl();
initializePreviewSizeControl();
elements.themeToggle.addEventListener("click", toggleTheme);
elements.openButtons.forEach((button) => button.addEventListener("click", openFolder));
elements.refreshButton.addEventListener("click", refreshFolder);
elements.trashSummary.addEventListener("click", selectTrash);
elements.moveButton.addEventListener("click", () => openMovePicker());
elements.trashButton.addEventListener("click", confirmTrash);
elements.imageGrid.addEventListener("click", handleGridClick);
elements.imageGrid.addEventListener("dblclick", handleGridDoubleClick);
elements.imageGrid.addEventListener("contextmenu", handleContextMenu);
elements.imageGrid.addEventListener("dragstart", handleDragStart);
elements.imageGrid.addEventListener("dragend", clearDragState);
elements.contentPanel.addEventListener("click", handleContentBackgroundClick);
elements.contextMenu.addEventListener("click", handleContextCommand);
elements.previewOverlay.addEventListener("click", handlePreviewOverlayClick);
elements.previewRenameButton.addEventListener("click", beginPreviewRename);
document.addEventListener("click", (event) => {
  if (!elements.contextMenu.contains(event.target)) hideContextMenu();
});
document.addEventListener("keydown", handleKeyDown);
window.addEventListener("beforeunload", () => revokeImageUrls([...state.images, ...state.trashImages]));

function readSavedColumnCount() {
  try {
    const saved = Number(localStorage.getItem("barceltool-column-count"));
    if (Number.isInteger(saved) && saved >= 1 && saved <= 10) return saved;
  } catch {}
  return 4;
}

function readSavedPreviewWidth() {
  try {
    const saved = Number(localStorage.getItem("barceltool-preview-width"));
    if (Number.isInteger(saved) && saved >= 300 && saved <= 1400) return saved;
  } catch {}
  return 690;
}

function readSavedPreviewFitEnabled() {
  try {
    const saved = localStorage.getItem("barceltool-preview-fit-enabled");
    if (saved === "false") return false;
    if (saved === "true") return true;
  } catch {}
  return true;
}

function readSavedPreviewVerticalFitEnabled() {
  try {
    return localStorage.getItem("barceltool-preview-vertical-fit-enabled") === "true";
  } catch {}
  return false;
}

function initializePreviewSizeControl() {
  elements.previewFitEnabled.checked = state.previewFitEnabled;
  elements.previewVerticalFitEnabled.checked = state.previewVerticalFitEnabled;
  elements.previewWidthSlider.value = String(state.previewWidth);
  elements.previewWidthSlider.addEventListener("input", () => setPreviewWidth(Number(elements.previewWidthSlider.value)));
  elements.previewWidthSlider.addEventListener("wheel", (event) => {
    event.preventDefault();
    setPreviewWidth(state.previewWidth + (event.deltaY < 0 ? 10 : -10));
  }, { passive: false });
  elements.previewFitEnabled.addEventListener("change", () => {
    state.previewFitEnabled = elements.previewFitEnabled.checked;
    try { localStorage.setItem("barceltool-preview-fit-enabled", String(state.previewFitEnabled)); } catch {}
    applyPreviewSize();
  });
  elements.previewVerticalFitEnabled.addEventListener("change", () => {
    state.previewVerticalFitEnabled = elements.previewVerticalFitEnabled.checked;
    try { localStorage.setItem("barceltool-preview-vertical-fit-enabled", String(state.previewVerticalFitEnabled)); } catch {}
    applyPreviewSize();
  });
  applyPreviewSize();
}

function setPreviewWidth(nextWidth) {
  state.previewWidth = Math.max(300, Math.min(1400, Math.round(nextWidth / 10) * 10));
  elements.previewWidthSlider.value = String(state.previewWidth);
  try { localStorage.setItem("barceltool-preview-width", String(state.previewWidth)); } catch {}
  applyPreviewSize();
}

function applyPreviewSize() {
  elements.previewWidthValue.value = `${state.previewWidth}px`;
  elements.previewWidthValue.textContent = `${state.previewWidth}px`;
  elements.previewOverlay.style.setProperty("--preview-image-width", `${state.previewWidth}px`);
  elements.previewOverlay.classList.toggle("preview-fit-enabled", state.previewFitEnabled);
  elements.previewOverlay.classList.toggle("preview-vertical-fit-enabled", state.previewVerticalFitEnabled);
  const widthControlDisabled = !state.previewFitEnabled || state.previewVerticalFitEnabled;
  elements.previewWidthSlider.disabled = widthControlDisabled;
  elements.previewWidthValue.classList.toggle("disabled", widthControlDisabled);
}

function initializeColumnControl() {
  elements.columnSlider.value = String(state.columnCount);
  elements.columnCount.value = String(state.columnCount);
  elements.columnCount.textContent = String(state.columnCount);
  elements.columnSlider.addEventListener("input", () => setColumnCount(Number(elements.columnSlider.value)));
  elements.columnSlider.addEventListener("wheel", (event) => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setColumnCount(state.columnCount + direction);
  }, { passive: false });
}

function setColumnCount(nextCount) {
  state.columnCount = Math.max(1, Math.min(10, Math.round(nextCount)));
  elements.columnSlider.value = String(state.columnCount);
  elements.columnCount.value = String(state.columnCount);
  elements.columnCount.textContent = String(state.columnCount);
  try { localStorage.setItem("barceltool-column-count", String(state.columnCount)); } catch {}
  scheduleMasonryLayout();
}

function initializeTheme() {
  let savedTheme = null;
  try { savedTheme = localStorage.getItem("barceltool-theme"); } catch {}
  const preferredTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(savedTheme === "dark" || savedTheme === "light" ? savedTheme : preferredTheme);
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("barceltool-theme", nextTheme); } catch {}
  applyTheme(nextTheme);
}

function applyTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = theme;
  elements.themeToggle.setAttribute("aria-pressed", String(dark));
  elements.themeToggle.setAttribute("aria-label", dark ? "라이트 모드로 전환" : "다크 모드로 전환");
  elements.themeToggle.querySelector(".theme-icon").textContent = dark ? "☀" : "☾";
  elements.themeToggle.querySelector(".theme-label").textContent = dark ? "라이트 모드" : "다크 모드";
}

async function openFolder() {
  hideContextMenu();
  if (!("showDirectoryPicker" in window)) {
    await showInfo("지원되지 않는 브라우저", "이 기능은 Chrome 또는 Edge 브라우저에서 사용할 수 있습니다.");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (!(await verifyPermission(handle, true))) return showPermissionMessage();
    state.rootDirectoryHandle = handle;
    await loadFromHandle("");
  } catch (error) {
    if (error.name !== "AbortError") await showInfo("폴더를 열 수 없습니다", describeError(error));
  }
}

async function refreshFolder() {
  if (!state.rootDirectoryHandle || state.operationInProgress) return;
  if (!(await verifyPermission(state.rootDirectoryHandle, true))) return showPermissionMessage();
  await loadFromHandle(state.selectedFolderPath);
}

async function loadFromHandle(preferredFolderPath) {
  setScanning(true);
  try {
    const previousImages = [...state.images, ...state.trashImages];
    imageLoadQueue.clear();
    revokeImageUrls(previousImages);
    state.images = [];
    state.trashImages = [];
    state.visibleImages = [];
    state.folderTree = null;
    state.viewingTrash = false;
    clearSelection();
    closePreview();
    let firstPaintDone = false;
    let progressFrame = 0;
    let lastProgressPaint = 0;
    const paintSnapshot = (snapshot, resetScroll = false, shouldRenderTree = false) => {
      state.images = snapshot.images;
      state.trashImages = snapshot.trashImages;
      state.folderTree = snapshot.folderTree;
      state.trashCount = snapshot.trashCount;
      if (!state.selectedFolderPath || !findFolderNode(snapshot.folderTree, state.selectedFolderPath)) {
        state.selectedFolderPath = snapshot.folderTree.fullPath;
      }
      updateTrashCount();
      if (shouldRenderTree) renderFolderTree();
      updateVisibleImages({ resetScroll, preserveNodes: firstPaintDone && !resetScroll });
      elements.emptyState.hidden = true;
      elements.contentHeader.hidden = false;
      elements.refreshButton.hidden = false;
    };
    const result = await scanDirectory(state.rootDirectoryHandle, {
      batchSize: 64,
      onProgress: async (snapshot) => {
        if (!firstPaintDone) {
          firstPaintDone = true;
          lastProgressPaint = performance.now();
          paintSnapshot(snapshot, true, true);
          return;
        }
        if (!snapshot.done && performance.now() - lastProgressPaint < 50) return;
        lastProgressPaint = performance.now();
        cancelAnimationFrame(progressFrame);
        progressFrame = requestAnimationFrame(() => paintSnapshot(snapshot));
      },
    });
    cancelAnimationFrame(progressFrame);
    state.images = result.images;
    state.trashImages = result.trashImages;
    state.folderTree = result.folderTree;
    state.trashCount = result.trashCount;
    state.selectedFolderPath = findFolderNode(result.folderTree, preferredFolderPath)
      ? preferredFolderPath
      : result.folderTree.fullPath;
    state.viewingTrash = false;
    paintSnapshot(result, !firstPaintDone, true);
  } catch (error) {
    await showInfo("폴더를 읽을 수 없습니다", describeError(error));
  } finally {
    setScanning(false);
  }
}

function setScanning(scanning) {
  state.scanning = scanning;
  elements.openButtons.forEach((button) => { button.disabled = scanning || state.operationInProgress; });
  elements.refreshButton.disabled = scanning || state.operationInProgress;
}

function renderFolderTree() {
  elements.folderTree.replaceChildren();
  if (!state.folderTree) return;
  elements.folderTree.appendChild(createTreeNodeElement(state.folderTree, 0, true));
}

function createTreeNodeElement(node, depth, expandedByDefault = false) {
  const wrapper = document.createElement("div");
  const row = createElement("div", "tree-row");
  const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const hasChildren = children.length > 0;
  row.classList.toggle("selected", !state.viewingTrash && node.fullPath === state.selectedFolderPath);
  row.classList.toggle("expanded", expandedByDefault);
  row.style.paddingLeft = `${depth * 16}px`;
  row.dataset.path = node.fullPath;
  row.title = node.fullPath;

  const toggle = createElement("button", `tree-toggle${hasChildren ? "" : " placeholder"}`);
  toggle.type = "button";
  toggle.setAttribute("aria-label", `${node.name} 하위 폴더 펼치기 또는 접기`);
  const childContainer = createElement("div", "tree-children");
  childContainer.hidden = !expandedByDefault;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!hasChildren) return;
    childContainer.hidden = row.classList.toggle("expanded") === false;
  });
  const icon = createElement("span", "folder-icon", "📁");
  const name = createElement("span", "folder-name", node.name);
  row.append(toggle, icon, name);
  row.addEventListener("click", () => selectFolder(node.fullPath));
  row.addEventListener("dragover", (event) => {
    if (!state.dragPaths.length || state.operationInProgress) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", async (event) => {
    event.preventDefault();
    row.classList.remove("drop-target");
    const paths = [...state.dragPaths];
    clearDragState();
    await confirmMoveTo(node, paths, true);
  });
  wrapper.append(row, childContainer);
  children.forEach((child) => childContainer.appendChild(createTreeNodeElement(child, depth + 1)));
  return wrapper;
}

function selectFolder(path) {
  if (state.operationInProgress) return;
  state.selectedFolderPath = path;
  state.viewingTrash = false;
  clearSelection();
  closePreview();
  renderFolderTree();
  updateVisibleImages({ resetScroll: true });
}

function selectTrash() {
  if (!state.rootDirectoryHandle || state.operationInProgress) return;
  state.viewingTrash = true;
  clearSelection();
  closePreview();
  renderFolderTree();
  updateVisibleImages({ resetScroll: true });
}

function updateVisibleImages({ resetScroll = false, preserveNodes = false } = {}) {
  const prefix = `${state.selectedFolderPath}/`;
  state.visibleImages = state.viewingTrash
    ? state.trashImages
    : state.images.filter((image) => image.relativePath.startsWith(prefix));
  const previousScrollTop = elements.imageGrid.scrollTop;
  renderImageGrid(preserveNodes);
  elements.imageGrid.scrollTop = resetScroll ? 0 : previousScrollTop;
  updateToolbar();
}

function renderImageGrid(preserveNodes = false) {
  calculateAndRenderMasonry(preserveNodes);
}

function calculateAndRenderMasonry(preserveNodes = false) {
  const { positions, totalHeight } = masonryLayout.calculate(
    state.visibleImages,
    elements.imageGrid.clientWidth,
    state.columnCount,
  );
  state.visibleImages.forEach((image, index) => { image.layout = positions[index]; });
  state.measuredImageIndexes.clear();
  if (preserveNodes) virtualRenderer.updateLayout(state.visibleImages, positions, totalHeight);
  else virtualRenderer.setData(state.visibleImages, positions, totalHeight);
}

function scheduleMasonryLayout() {
  cancelAnimationFrame(scheduleMasonryLayout.frameId);
  scheduleMasonryLayout.frameId = requestAnimationFrame(() => calculateAndRenderMasonry(true));
}

function createThumbnailCard() {
  const card = createElement("article", "thumbnail-card");
  card.tabIndex = 0;
  card.draggable = true;
  const imageBox = createElement("div", "thumbnail-image-box");
  const thumbnail = document.createElement("img");
  thumbnail.alt = "";
  thumbnail.decoding = "async";
  imageBox.appendChild(thumbnail);
  const details = createElement("div", "thumbnail-details");
  details.append(
    createElement("span", "thumbnail-name"),
    createElement("span", "thumbnail-extension"),
  );
  const check = createElement("span", "thumbnail-check", "✓");
  check.setAttribute("aria-hidden", "true");
  const continuation = createElement("div", "thumbnail-continuation");
  continuation.setAttribute("aria-hidden", "true");
  const continuationArrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  continuationArrow.classList.add("thumbnail-continuation-arrow");
  continuationArrow.setAttribute("viewBox", "0 0 80 32");
  const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrowPath.setAttribute("d", "M 7 6 L 40 26 L 73 6");
  continuationArrow.appendChild(arrowPath);
  continuation.appendChild(continuationArrow);
  card.append(imageBox, continuation, details, check);
  return card;
}

function updateThumbnailCard(card, image, index) {
  if (!image) return;
  card.dataset.index = String(index);
  card.title = image.relativePath;
  card.classList.toggle("selected", state.selectedPaths.has(image.relativePath));
  card.classList.toggle("is-truncated", Boolean(image.layout?.isTruncated));
  const thumbnail = card.querySelector("img");
  card.classList.toggle("is-loading", !image.objectUrl);
  if (image.objectUrl && thumbnail.dataset.src !== image.objectUrl) {
    thumbnail.removeAttribute("src");
    thumbnail.dataset.src = image.objectUrl;
  } else if (!image.objectUrl) {
    thumbnail.removeAttribute("src");
    thumbnail.removeAttribute("data-src");
  }
  thumbnail.alt = image.name;
  card.querySelector(".thumbnail-name").textContent = image.name;
  card.querySelector(".thumbnail-extension").textContent = image.extension.toUpperCase();
}

function readImageDimensions(objectUrl) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = reject;
    probe.src = objectUrl;
  });
}

async function loadImageResource(image) {
  if (image.objectUrl && image.naturalWidth && image.naturalHeight) return image;
  const file = await image.fileHandle.getFile();
  let width = 0;
  let height = 0;
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {}
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    if (!width || !height) {
      const dimensions = await readImageDimensions(objectUrl);
      width = dimensions.width;
      height = dimensions.height;
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
  image.file = file;
  image.objectUrl = objectUrl;
  image.naturalWidth = width || 1;
  image.naturalHeight = height || 1;
  return image;
}

function handleQueuedImageLoaded(image) {
  const index = state.visibleImages.indexOf(image);
  if (index >= 0) state.measuredImageIndexes.add(index);
  virtualRenderer.refreshRenderedCards();
  scheduleDimensionRelayout();
}

function scheduleDimensionRelayout() {
  clearTimeout(state.dimensionRelayoutTimer);
  state.dimensionRelayoutTimer = setTimeout(() => {
    const changedIndexes = [...state.measuredImageIndexes];
    state.measuredImageIndexes.clear();
    if (!changedIndexes.length) return;
    const result = masonryLayout.updateMeasuredItems(state.visibleImages, changedIndexes);
    if (!result) return calculateAndRenderMasonry(true);
    changedIndexes.forEach((index) => {
      if (state.visibleImages[index]) state.visibleImages[index].layout = result.positions[index];
    });
    virtualRenderer.updateLayout(state.visibleImages, result.positions, result.totalHeight);
  }, 80);
}

function handleGridClick(event) {
  const card = event.target.closest(".thumbnail-card");
  if (!card) return;
  applySelection(Number(card.dataset.index), event);
}

function applySelection(index, event = {}) {
  const image = state.visibleImages[index];
  if (!image) return;
  if (event.shiftKey && state.selectionAnchor >= 0) {
    if (!(event.ctrlKey || event.metaKey)) state.selectedPaths.clear();
    const [start, end] = [state.selectionAnchor, index].sort((a, b) => a - b);
    state.visibleImages.slice(start, end + 1).forEach((item) => state.selectedPaths.add(item.relativePath));
  } else if (event.ctrlKey || event.metaKey) {
    if (state.selectedPaths.has(image.relativePath)) state.selectedPaths.delete(image.relativePath);
    else state.selectedPaths.add(image.relativePath);
    state.selectionAnchor = index;
  } else {
    state.selectedPaths.clear();
    state.selectedPaths.add(image.relativePath);
    state.selectionAnchor = index;
  }
  syncSelectionUI();
}

function clearSelection() {
  state.selectedPaths.clear();
  state.selectionAnchor = -1;
  syncSelectionUI();
}

function syncSelectionUI() {
  virtualRenderer.refreshRenderedCards();
  updateToolbar();
}

function getSelectedImages(paths = [...state.selectedPaths]) {
  const pathSet = new Set(paths);
  const source = state.viewingTrash ? state.trashImages : state.images;
  return source.filter((image) => pathSet.has(image.relativePath));
}

function updateToolbar() {
  if (state.viewingTrash) {
    elements.statusText.textContent = `휴지통 · ${state.visibleImages.length.toLocaleString("ko-KR")}개`;
  } else {
    const isRoot = state.folderTree && state.selectedFolderPath === state.folderTree.fullPath;
    const folderName = state.selectedFolderPath.split("/").pop() || "폴더";
    elements.statusText.textContent = isRoot
      ? `전체 이미지 ${state.visibleImages.length.toLocaleString("ko-KR")}개`
      : `${folderName} 및 하위 폴더 · ${state.visibleImages.length.toLocaleString("ko-KR")}개`;
  }
  const count = state.selectedPaths.size;
  elements.selectionCount.hidden = count === 0;
  elements.selectionCount.textContent = `${count.toLocaleString("ko-KR")}개 선택됨`;
  elements.moveButton.disabled = count === 0 || state.operationInProgress || state.viewingTrash;
  elements.trashButton.disabled = count === 0 || state.operationInProgress || state.viewingTrash;
  elements.trashSummary.classList.toggle("selected", state.viewingTrash);
}

function handleContentBackgroundClick(event) {
  if (event.target === elements.imageGrid || event.target === elements.masonryCanvas || event.target === elements.contentPanel) clearSelection();
}

function handleGridDoubleClick(event) {
  const card = event.target.closest(".thumbnail-card");
  if (!card) return;
  const index = Number(card.dataset.index);
  if (!state.selectedPaths.has(state.visibleImages[index].relativePath)) applySelection(index);
  openPreview(index);
}

function handleContextMenu(event) {
  const card = event.target.closest(".thumbnail-card");
  if (!card) return;
  event.preventDefault();
  const index = Number(card.dataset.index);
  const image = state.visibleImages[index];
  if (!state.selectedPaths.has(image.relativePath)) applySelection(index);
  const width = 180;
  const x = Math.min(event.clientX, window.innerWidth - width - 8);
  const y = Math.min(event.clientY, window.innerHeight - 170);
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.top = `${Math.max(8, y)}px`;
  elements.contextMenu.querySelector('[data-command="move"]').disabled = state.viewingTrash;
  elements.contextMenu.querySelector('[data-command="trash"]').disabled = state.viewingTrash;
  elements.contextMenu.hidden = false;
}

function hideContextMenu() {
  elements.contextMenu.hidden = true;
}

async function handleContextCommand(event) {
  const command = event.target.closest("button")?.dataset.command;
  if (!command) return;
  hideContextMenu();
  if (command === "preview") openSelectedPreview();
  if (command === "move" && !state.viewingTrash) await openMovePicker();
  if (command === "trash" && !state.viewingTrash) await confirmTrash();
  if (command === "delete") await confirmPermanentDelete();
}

function handleDragStart(event) {
  const card = event.target.closest(".thumbnail-card");
  if (!card || state.operationInProgress) return event.preventDefault();
  const image = state.visibleImages[Number(card.dataset.index)];
  if (!state.selectedPaths.has(image.relativePath)) applySelection(Number(card.dataset.index));
  state.dragPaths = [...state.selectedPaths];
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", "barceltool-internal-move");
}

function clearDragState() {
  state.dragPaths = [];
  document.querySelectorAll(".dragging, .drop-target").forEach((element) => element.classList.remove("dragging", "drop-target"));
}

async function confirmTrash() {
  if (!state.selectedPaths.size || state.operationInProgress) return;
  const images = getSelectedImages();
  const body = createElement("div");
  if (images.length === 1) {
    body.append(
      createElement("p", "", "이 이미지를 휴지통으로 이동하시겠습니까?"),
      createElement("p", "", images[0].name),
      createElement("p", "modal-path", images[0].folderPath.replaceAll("/", " > ")),
    );
  } else body.appendChild(createElement("p", "", `선택한 이미지 ${images.length}개를 휴지통으로 이동하시겠습니까?`));
  body.appendChild(createElement("p", "modal-warning", "파일은 최상위 폴더의 .barceltool-trash로 이동합니다."));
  const confirmed = await showModal({ title: "휴지통으로 이동", body, actions: cancelAnd("이동", "danger", true) });
  if (confirmed) await runTrash(images);
}

async function confirmPermanentDelete() {
  if (!state.selectedPaths.size || state.operationInProgress) return;
  const images = getSelectedImages();
  const body = createElement("div");
  body.appendChild(createElement("p", "", images.length === 1
    ? `이 파일을 영구 삭제하시겠습니까?\n${images[0].name}`
    : `선택한 이미지 ${images.length}개를 영구 삭제하시겠습니까?`));
  body.appendChild(createElement("p", "modal-warning", "이 작업은 되돌릴 수 없으며 운영체제 휴지통으로 이동하지 않습니다."));
  const confirmed = await showModal({ title: "영구 삭제", body, actions: cancelAnd("영구 삭제", "danger", true) });
  if (confirmed) await runPermanentDelete(images);
}

async function runTrash(images, { silent = false } = {}) {
  if (!(await ensureWritePermission(silent))) return;
  await runFileOperation("이미지 휴지통 이동 중", images, async (image) => {
    const result = await moveToTrash(image, state.rootDirectoryHandle);
    addTrashImage(image, result);
    removeImageFromState(image);
    updateTrashCount();
  }, "이동", { silent });
}

async function runPermanentDelete(images, { silent = false } = {}) {
  if (!(await ensureWritePermission(silent))) return;
  await runFileOperation("이미지 영구 삭제 중", images, async (image) => {
    await permanentlyDelete(image);
    removeImageFromState(image);
  }, "삭제", { silent });
}

async function runFileOperation(title, images, worker, verb, { silent = false } = {}) {
  setBusy(true);
  if (!silent) {
    const progressBody = createElement("div");
    progressBody.append(createElement("p", "", "파일 작업이 끝날 때까지 잠시 기다려주세요."), createElement("div", "progress-count", `0 / ${images.length}`));
    showModal({ title, body: progressBody, canDismiss: false });
  }
  const failures = [];
  let completed = 0;
  for (const image of images) {
    try { await worker(image); }
    catch (error) { failures.push({ name: image.name, reason: describeError(error) }); }
    completed += 1;
    if (!silent) updateModalProgress(completed, images.length);
  }
  if (!silent) closeModal();
  state.selectedPaths.clear();
  closePreview();
  updateVisibleImages();
  setBusy(false);
  if (!silent) await showResult(`${images.length - failures.length}개 ${verb} 완료`, failures, verb);
}

function removeImageFromState(image) {
  URL.revokeObjectURL(image.objectUrl);
  state.images = state.images.filter((item) => item !== image);
  state.trashImages = state.trashImages.filter((item) => item !== image);
  state.trashCount = state.trashImages.length;
  state.selectedPaths.delete(image.relativePath);
  updateTrashCount();
}

function addTrashImage(sourceImage, result) {
  const folderPath = `${state.rootDirectoryHandle.name}/.barceltool-trash`;
  const relativePath = `${folderPath}/${result.targetName}`;
  state.trashImages.push({
    file: result.file,
    fileHandle: result.fileHandle,
    parentDirectoryHandle: result.trashHandle,
    name: result.targetName,
    extension: sourceImage.extension,
    relativePath,
    folderPath,
    pathParts: relativePath.split("/"),
    objectUrl: URL.createObjectURL(result.file),
    naturalWidth: sourceImage.naturalWidth || 0,
    naturalHeight: sourceImage.naturalHeight || 0,
    isTrashItem: true,
  });
  state.trashCount = state.trashImages.length;
}

function updateTrashCount() {
  elements.trashCount.textContent = state.trashCount.toLocaleString("ko-KR");
  elements.trashCount.title = `휴지통 이미지 ${state.trashCount.toLocaleString("ko-KR")}개`;
}

async function openMovePicker(paths = [...state.selectedPaths]) {
  if (!paths.length || state.operationInProgress) return;
  const images = getSelectedImages(paths);
  const body = createElement("div");
  body.appendChild(createElement("p", "", `이미지 ${images.length}개 이동 · 이동할 폴더를 선택하세요.`));
  const picker = createElement("div", "folder-picker");
  body.appendChild(picker);
  let targetNode = null;
  picker.appendChild(createFolderPickerNode(state.folderTree, 0, (node, button) => {
    targetNode = node;
    picker.querySelectorAll(".folder-choice.selected").forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
    const allAlreadyThere = images.every((image) => image.folderPath === node.fullPath);
    setModalActionEnabled("move-confirm", !allAlreadyThere);
  }, true));
  const result = await showModal({
    title: "이미지 이동",
    body,
    actions: [
      { label: "취소", value: null },
      { id: "move-confirm", label: "이동", value: true, className: "primary", disabled: true },
    ],
  });
  if (result && targetNode) await confirmMoveTo(targetNode, paths, false);
}

function createFolderPickerNode(node, depth, onSelect, expanded = false) {
  const wrapper = createElement("div");
  const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const row = createElement("div");
  const button = createElement("button", "folder-choice");
  button.type = "button";
  button.style.paddingLeft = `${depth * 14}px`;
  const toggle = createElement("span", "folder-choice-toggle", children.length ? (expanded ? "▾" : "▸") : "");
  button.append(toggle, createElement("span", "", "📁"), createElement("span", "folder-name", node.name));
  button.addEventListener("click", () => onSelect(node, button));
  const childBox = createElement("div");
  childBox.hidden = !expanded;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    childBox.hidden = !childBox.hidden;
    toggle.textContent = childBox.hidden ? "▸" : "▾";
  });
  children.forEach((child) => childBox.appendChild(createFolderPickerNode(child, depth + 1, onSelect)));
  row.appendChild(button);
  wrapper.append(row, childBox);
  return wrapper;
}

async function confirmMoveTo(targetNode, paths, fromDrag) {
  const images = getSelectedImages(paths).filter((image) => image.folderPath !== targetNode.fullPath);
  if (!images.length) return;
  if (fromDrag) {
    const body = createElement("p", "", `선택한 이미지 ${images.length}개를\n${targetNode.fullPath.replaceAll("/", " > ")} 폴더로 이동하시겠습니까?`);
    const confirmed = await showModal({ title: "이미지 이동", body, actions: cancelAnd("이동", "primary", true) });
    if (!confirmed) return;
  }
  await runMove(images, targetNode);
}

async function runMove(images, targetNode) {
  if (!(await ensureWritePermission())) return;
  setBusy(true);
  const progressBody = createElement("div");
  progressBody.append(createElement("p", "", "복사와 파일 크기 확인 후 원본을 제거합니다."), createElement("div", "progress-count", `0 / ${images.length}`));
  showModal({ title: "이미지 이동 중", body: progressBody, canDismiss: false });
  const failures = [];
  let conflictPolicy = null;
  let applyToRemaining = false;
  let successCount = 0;
  let skippedCount = 0;

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    try {
      let targetName = image.name;
      let overwrite = false;
      if (await entryExists(targetNode.directoryHandle, targetName)) {
        let policy = applyToRemaining ? conflictPolicy : null;
        if (!policy) {
          closeModal();
          const decision = await askConflict(image.name, images.length - index > 1);
          if (!decision || decision.policy === "cancel") break;
          policy = decision.policy;
          conflictPolicy = policy;
          applyToRemaining = decision.applyToRemaining;
          showModal({ title: "이미지 이동 중", body: progressBody, canDismiss: false });
        }
        if (policy === "skip") { skippedCount += 1; updateModalProgress(index + 1, images.length); continue; }
        if (policy === "rename") targetName = await createAvailableName(targetNode.directoryHandle, image.name);
        if (policy === "overwrite") overwrite = true;
      }
      const result = await copyThenRemove(image, targetNode.directoryHandle, targetName, overwrite);
      updateMovedImage(image, targetNode, result);
      successCount += 1;
    } catch (error) {
      failures.push({ name: image.name, reason: describeError(error) });
    }
    updateModalProgress(index + 1, images.length);
  }
  closeModal();
  state.selectedPaths.clear();
  closePreview();
  updateVisibleImages();
  setBusy(false);
  const skippedText = skippedCount ? ` · ${skippedCount}개 건너뜀` : "";
  await showResult(`${successCount}개 이동 완료${skippedText}`, failures, "이동");
}

async function askConflict(fileName, showApplyOption) {
  const body = createElement("div");
  body.appendChild(createElement("p", "", `${fileName} 파일이 대상 폴더에 이미 있습니다.`));
  const options = createElement("div", "collision-options");
  const policies = [["skip", "건너뛰기"], ["rename", "이름 변경 후 이동"], ["overwrite", "덮어쓰기"], ["cancel", "취소"]];
  policies.forEach(([value, label], index) => {
    const input = document.createElement("input");
    input.type = "radio"; input.name = "collision-policy"; input.value = value; input.checked = index === 0;
    const wrapper = document.createElement("label"); wrapper.append(input, label); options.appendChild(wrapper);
  });
  body.appendChild(options);
  let applyCheckbox = null;
  if (showApplyOption) {
    applyCheckbox = document.createElement("input"); applyCheckbox.type = "checkbox";
    const wrapper = document.createElement("label"); wrapper.append(applyCheckbox, " 남은 충돌 파일에도 같은 방식 적용"); body.appendChild(wrapper);
  }
  const accepted = await showModal({ title: "같은 이름의 파일", body, actions: cancelAnd("계속", "primary", true) });
  if (!accepted) return null;
  return { policy: body.querySelector('input[name="collision-policy"]:checked').value, applyToRemaining: Boolean(applyCheckbox?.checked) };
}

function updateMovedImage(image, targetNode, result) {
  URL.revokeObjectURL(image.objectUrl);
  image.file = result.file;
  image.fileHandle = result.fileHandle;
  image.parentDirectoryHandle = targetNode.directoryHandle;
  image.name = result.targetName;
  image.relativePath = `${targetNode.fullPath}/${result.targetName}`;
  image.folderPath = targetNode.fullPath;
  image.pathParts = image.relativePath.split("/");
  image.objectUrl = URL.createObjectURL(result.file);
}

function openSelectedPreview() {
  const index = state.visibleImages.findIndex((image) => state.selectedPaths.has(image.relativePath));
  if (index >= 0) openPreview(index);
}

function openPreview(index) {
  if (!state.visibleImages[index]) return;
  state.previewIndex = index;
  updatePreview();
  elements.previewOverlay.hidden = false;
}

function updatePreview() {
  const image = state.visibleImages[state.previewIndex];
  if (!image) return closePreview();
  elements.previewImage.onload = () => { elements.previewImage.parentElement.scrollTop = 0; };
  if (image.objectUrl) {
    elements.previewImage.src = image.objectUrl;
  } else {
    elements.previewImage.removeAttribute("src");
    const requestedPath = image.relativePath;
    imageLoadQueue.enqueue(image, -1).then(() => {
      const current = state.visibleImages[state.previewIndex];
      if (current?.relativePath === requestedPath && image.objectUrl) elements.previewImage.src = image.objectUrl;
    }).catch(() => {});
  }
  elements.previewImage.parentElement.scrollTop = 0;
  elements.previewImage.alt = image.name;
  elements.previewPath.replaceChildren(...breadcrumbNodes(image.folderPath));
  elements.previewBadge.textContent = image.extension.toUpperCase();
  elements.previewBadge.className = `extension-badge ext-${image.extension}`;
  cancelPreviewRename();
  elements.previewIndexLabel.textContent = `${state.previewIndex + 1} / ${state.visibleImages.length}`;
  elements.previewFileName.textContent = image.name;
  state.selectedPaths.clear();
  state.selectedPaths.add(image.relativePath);
  state.selectionAnchor = state.previewIndex;
  syncSelectionUI();
}

function closePreview() {
  cancelPreviewRename();
  elements.previewOverlay.hidden = true;
  elements.previewImage.onload = null;
  elements.previewImage.removeAttribute("src");
  state.previewIndex = -1;
}

function beginPreviewRename() {
  const image = state.visibleImages[state.previewIndex];
  if (!image || state.operationInProgress || elements.previewCounter.querySelector(".preview-rename-input")) return;
  const extensionWithDot = `.${image.extension}`;
  const baseName = image.name.toLowerCase().endsWith(extensionWithDot.toLowerCase())
    ? image.name.slice(0, -extensionWithDot.length)
    : image.name;
  const editor = createElement("span", "preview-rename-editor");
  const input = document.createElement("input");
  input.className = "preview-rename-input";
  input.type = "text";
  input.value = baseName;
  input.setAttribute("aria-label", "새 파일 이름");
  const extension = createElement("span", "preview-rename-extension", extensionWithDot);
  editor.append(input, extension);
  elements.previewFileName.hidden = true;
  elements.previewRenameButton.hidden = true;
  elements.previewCounter.insertBefore(editor, elements.previewRenameButton);

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    if (save) await renamePreviewImage(image, input.value);
    cancelPreviewRename();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); finish(true); }
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.select();
}

function cancelPreviewRename() {
  elements.previewCounter.querySelector(".preview-rename-editor")?.remove();
  elements.previewFileName.hidden = false;
  elements.previewRenameButton.hidden = false;
}

async function renamePreviewImage(image, requestedBaseName) {
  const baseName = requestedBaseName.trim();
  if (!baseName || /[<>:"/\\|?*\u0000-\u001F]/.test(baseName) || baseName.endsWith(".")) {
    await showInfo("이름을 변경할 수 없습니다", "파일 이름에 사용할 수 없는 문자가 포함되어 있습니다.");
    return;
  }
  const newName = `${baseName}.${image.extension}`;
  if (newName === image.name) return;
  if (!(await ensureWritePermission())) return;
  setBusy(true);
  const oldPath = image.relativePath;
  try {
    const result = await copyThenRemove(image, image.parentDirectoryHandle, newName, false);
    URL.revokeObjectURL(image.objectUrl);
    image.file = result.file;
    image.fileHandle = result.fileHandle;
    image.name = result.targetName;
    image.relativePath = `${image.folderPath}/${result.targetName}`;
    image.pathParts = image.relativePath.split("/");
    image.objectUrl = URL.createObjectURL(result.file);
    if (state.selectedPaths.delete(oldPath)) state.selectedPaths.add(image.relativePath);
    calculateAndRenderMasonry();
    updatePreview();
  } catch (error) {
    await showInfo("이름을 변경할 수 없습니다", describeError(error));
  } finally {
    setBusy(false);
  }
}

function movePreview(offset) {
  state.previewIndex = (state.previewIndex + offset + state.visibleImages.length) % state.visibleImages.length;
  updatePreview();
}

function handlePreviewOverlayClick(event) {
  if (event.target === elements.previewOverlay || event.target.classList.contains("preview-stage")) closePreview();
}

function handleKeyDown(event) {
  const editable = event.target.matches("input, textarea, select, [contenteditable='true']");
  const buttonSpace = event.code === "Space" && event.target.closest("button");
  if (editable || buttonSpace) return;
  const previewOpen = !elements.previewOverlay.hidden;
  const modalOpen = !elements.modalOverlay.hidden;
  if (event.key === "Escape") {
    if (previewOpen) closePreview();
    else if (!elements.contextMenu.hidden) hideContextMenu();
    else if (modalOpen) dismissModal();
    return;
  }
  if (modalOpen || state.operationInProgress || state.keyboardOperationPending) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    state.visibleImages.forEach((image) => state.selectedPaths.add(image.relativePath));
    syncSelectionUI();
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    if (previewOpen) closePreview(); else openSelectedPreview();
    return;
  }
  if (previewOpen && event.key === "ArrowLeft") { event.preventDefault(); movePreview(-1); return; }
  if (previewOpen && event.key === "ArrowRight") { event.preventDefault(); movePreview(1); return; }
  if (!previewOpen && state.selectedPaths.size && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    const selectedImages = getSelectedImages();
    if (state.viewingTrash && !event.shiftKey) return;
    state.keyboardOperationPending = true;
    const operation = event.shiftKey
      ? runPermanentDelete(selectedImages, { silent: true })
      : runTrash(selectedImages, { silent: true });
    Promise.resolve(operation).finally(() => { state.keyboardOperationPending = false; });
  }
}

function breadcrumbNodes(path) {
  const nodes = [];
  path.split("/").forEach((part, index) => {
    if (index) nodes.push(createElement("span", "breadcrumb-separator", ">"));
    nodes.push(createElement("span", "", part));
  });
  return nodes;
}

async function ensureWritePermission(silent = false) {
  if (state.rootDirectoryHandle && await verifyPermission(state.rootDirectoryHandle, true)) return true;
  if (!silent) await showPermissionMessage();
  return false;
}

function showPermissionMessage() {
  return showInfo("권한이 필요합니다", "파일을 변경하려면 선택한 폴더의 읽기 및 쓰기 권한이 필요합니다.");
}

function showInfo(title, message) {
  return showModal({ title, body: message, actions: [{ label: "확인", value: true, className: "primary" }] });
}

async function showResult(successTitle, failures, verb) {
  if (!failures.length) return showInfo("작업 완료", successTitle);
  const body = createElement("div");
  body.append(createElement("p", "", successTitle), createElement("p", "modal-warning", `${failures.length}개 ${verb} 실패`));
  const list = createElement("ul", "result-list");
  failures.forEach((failure) => list.appendChild(createElement("li", "", `${failure.name} — ${failure.reason}`)));
  body.appendChild(list);
  return showModal({ title: "일부 파일 처리 실패", body, actions: [{ label: "확인", value: true, className: "primary" }] });
}

function cancelAnd(label, className, value) {
  return [{ label: "취소", value: null }, { label, value, className }];
}

function setBusy(busy) {
  state.operationInProgress = busy;
  elements.openButtons.forEach((button) => { button.disabled = busy || state.scanning; });
  elements.refreshButton.disabled = busy || state.scanning;
  updateToolbar();
}
})();
