(function initializeFileSystemModule() {
"use strict";

const SUPPORTED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"]);
const TRASH_FOLDER_NAME = ".barceltool-trash";

async function verifyPermission(handle, withWrite = false) {
  const options = withWrite ? { mode: "readwrite" } : {};
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function scanDirectory(rootHandle, { onProgress, batchSize = 64 } = {}) {
  const root = createFolderNode(rootHandle.name, rootHandle.name, rootHandle);
  const images = [];
  const trashImages = [];
  const scanContext = { root, images, trashImages, onProgress, batchSize, discovered: 0 };
  for await (const [name, handle] of rootHandle.entries()) {
    if (name === TRASH_FOLDER_NAME && handle.kind === "directory") {
      await scanTrashImages(handle, rootHandle.name, `${rootHandle.name}/${TRASH_FOLDER_NAME}`, scanContext);
      continue;
    }
    await processDirectoryEntry(name, handle, rootHandle, root, scanContext);
  }
  await emitScanProgress(scanContext, true);
  return { folderTree: root, images, trashImages, trashCount: trashImages.length };
}

async function walkDirectory(directoryHandle, folderNode, scanContext) {
  for await (const [name, handle] of directoryHandle.entries()) {
    if (name !== TRASH_FOLDER_NAME) await processDirectoryEntry(name, handle, directoryHandle, folderNode, scanContext);
  }
}

async function processDirectoryEntry(name, handle, parentHandle, folderNode, scanContext) {
  if (handle.kind === "directory") {
    const fullPath = `${folderNode.fullPath}/${name}`;
    const child = createFolderNode(name, fullPath, handle);
    folderNode.children.set(name, child);
    await walkDirectory(handle, child, scanContext);
    return;
  }
  const extension = getExtension(name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) return;
  const relativePath = `${folderNode.fullPath}/${name}`;
  scanContext.images.push({
    file: null,
    fileHandle: handle,
    parentDirectoryHandle: parentHandle,
    name,
    extension,
    relativePath,
    folderPath: folderNode.fullPath,
    pathParts: relativePath.split("/"),
    objectUrl: null,
  });
  await emitScanProgress(scanContext);
}

async function scanTrashImages(directoryHandle, rootName, folderPath, scanContext) {
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "directory") {
      await scanTrashImages(handle, rootName, `${folderPath}/${name}`, scanContext);
      continue;
    }
    const extension = getExtension(name);
    if (!SUPPORTED_EXTENSIONS.has(extension)) continue;
    const relativePath = `${folderPath}/${name}`;
    scanContext.trashImages.push({
      file: null,
      fileHandle: handle,
      parentDirectoryHandle: directoryHandle,
      name,
      extension,
      relativePath,
      folderPath,
      pathParts: [rootName, ...relativePath.split("/").slice(1)],
      objectUrl: null,
      isTrashItem: true,
    });
    await emitScanProgress(scanContext);
  }
}

async function emitScanProgress(scanContext, done = false) {
  scanContext.discovered += done ? 0 : 1;
  if (!scanContext.onProgress || !done && scanContext.discovered !== 1 && scanContext.discovered % scanContext.batchSize !== 0) return;
  await scanContext.onProgress({
    folderTree: scanContext.root,
    images: scanContext.images,
    trashImages: scanContext.trashImages,
    trashCount: scanContext.trashImages.length,
    done,
  });
  if (!done) await new Promise((resolve) => setTimeout(resolve, 0));
}

function createFolderNode(name, fullPath, directoryHandle) {
  return { name, fullPath, directoryHandle, children: new Map() };
}

function findFolderNode(root, fullPath) {
  if (!root || !fullPath) return null;
  if (root.fullPath === fullPath) return root;
  const parts = fullPath.split("/").slice(1);
  let node = root;
  for (const part of parts) {
    node = node.children.get(part);
    if (!node) return null;
  }
  return node;
}

async function entryExists(directoryHandle, name) {
  try {
    await directoryHandle.getFileHandle(name);
    return true;
  } catch (error) {
    if (error.name === "NotFoundError") return false;
    throw error;
  }
}

async function createAvailableName(directoryHandle, fileName, style = "number") {
  if (!(await entryExists(directoryHandle, fileName))) return fileName;
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  let number = 1;
  while (true) {
    const suffix = style === "trash" ? `_${date}_${number}` : `_${number}`;
    const candidate = `${base}${suffix}${extension}`;
    if (!(await entryExists(directoryHandle, candidate))) return candidate;
    number += 1;
  }
}

async function createChildDirectory(parentDirectoryHandle, name) {
  try {
    await parentDirectoryHandle.getDirectoryHandle(name);
    throw Object.assign(new Error("같은 이름의 폴더가 이미 있습니다."), { code: "DIRECTORY_EXISTS" });
  } catch (error) {
    if (error.code === "DIRECTORY_EXISTS") throw error;
    if (error.name !== "NotFoundError") throw error;
  }
  return parentDirectoryHandle.getDirectoryHandle(name, { create: true });
}

// 대상 쓰기와 크기 검증이 모두 끝난 뒤에만 원본을 제거한다.
async function copyThenRemove(image, targetDirectoryHandle, targetName, overwrite = false) {
  if (!overwrite && (await entryExists(targetDirectoryHandle, targetName))) {
    throw Object.assign(new Error("같은 이름의 파일이 있습니다."), { code: "NAME_CONFLICT" });
  }
  const sourceFile = await image.fileHandle.getFile();
  const targetFileHandle = await targetDirectoryHandle.getFileHandle(targetName, { create: true });
  const writable = await targetFileHandle.createWritable();
  try {
    await writable.write(sourceFile);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch {}
    throw error;
  }
  const copiedFile = await targetFileHandle.getFile();
  if (copiedFile.size !== sourceFile.size) {
    if (!overwrite) {
      try { await targetDirectoryHandle.removeEntry(targetName); } catch {}
    }
    throw new Error("복사된 파일 크기가 원본과 다릅니다.");
  }
  await image.parentDirectoryHandle.removeEntry(image.name);
  return { file: copiedFile, fileHandle: targetFileHandle, targetName };
}

async function moveToTrash(image, rootHandle) {
  const trashHandle = await rootHandle.getDirectoryHandle(TRASH_FOLDER_NAME, { create: true });
  const targetName = await createAvailableName(trashHandle, image.name, "trash");
  const result = await copyThenRemove(image, trashHandle, targetName);
  return { ...result, trashHandle };
}

async function permanentlyDelete(image) {
  await image.parentDirectoryHandle.removeEntry(image.name);
}

function revokeImageUrls(images) {
  images.forEach((image) => {
    if (image.objectUrl) URL.revokeObjectURL(image.objectUrl);
  });
}

function describeError(error) {
  if (error?.name === "NotAllowedError") return "권한이 거부되었습니다.";
  if (error?.name === "NotFoundError") return "원본 파일을 찾을 수 없습니다.";
  if (error?.name === "NoModificationAllowedError") return "파일을 변경할 수 없습니다.";
  return error?.message || "알 수 없는 오류가 발생했습니다.";
}

function getExtension(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

window.BarcelFileSystem = {
  copyThenRemove,
  createAvailableName,
  createChildDirectory,
  describeError,
  entryExists,
  findFolderNode,
  moveToTrash,
  permanentlyDelete,
  revokeImageUrls,
  scanDirectory,
  verifyPermission,
};
})();
