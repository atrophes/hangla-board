import { BOARD_WIDTH, LABEL_WIDTH, ROW_HEIGHT, LINE_WIDTH, BACKGROUND, createState, defaultWidth, imageSize, constrainPlacement, layoutBounds, findOpenPosition, retractPadding } from './board-model.mjs';
import { MAX_HISTORY, encodeSession, decodeSession } from './editor-session.mjs';
import { saveAndCopyImage } from './export-image.mjs';

// Keep the existing database: upgrading the editor must not discard a user's work.
const DB_NAME = 'hangla-free-board-v3';
const elements = Object.fromEntries([
  'assetCount', 'assetList', 'uploadZone', 'fileInput', 'rankBoard', 'boardBackground', 'placementLayer', 'boardViewport',
  'undoButton', 'redoButton', 'exportButton', 'copyBoardButton', 'tierSettingsButton', 'extendTopButton', 'extendBottomButton',
  'retractTopButton', 'retractBottomButton', 'exportModal', 'exportPreview', 'saveExportButton', 'copyExportButton', 'exportHelp', 'exportStatus', 'closeExportButton',
  'selectionBar', 'selectionPreview', 'selectionLabel', 'clearSelectionButton', 'removePlacementButton', 'imageScale', 'scaleOutput',
  'tierModal', 'tierForm', 'tierEditor', 'addTierButton', 'addTopTierButton', 'itemModal', 'itemForm', 'itemNameInput', 'deleteItemButton', 'toast',
].map((id) => [id, document.getElementById(id)]));
let state = createState();
let selectedId = null;
let pendingAssetId = null;
let editingAssetId = null;
let draggingAssetId = null;
let pointerDrag = null;
let sliderBefore = null;
let tierDraft = [];
let undoStack = [];
let redoStack = [];
let toastTimer;
let saveTimer;
let suppressClickUntil = 0;
let importQueue = Promise.resolve();
let lastBackgroundMarkup = '';
let exportBlob = null;
let exportUrl = null;

const uid = (prefix = 'item') => `${prefix}-${crypto.randomUUID()}`;
const assetById = (id) => state.items.find((item) => item.id === id);
const placementById = (id) => state.placements.find((item) => item.id === id);
const nextZ = () => Math.max(0, ...state.placements.map((item) => item.z || 0)) + 1;
const snapshot = () => structuredClone(state);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function icons() {
  window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } });
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2600);
}

function pushHistory(before) {
  undoStack.push(before);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
}

function collectUnusedAssets() {
  const referenced = new Set(state.placements.map((item) => item.assetId));
  state.items = state.items.filter((item) => item.inLibrary !== false || referenced.has(item.id));
}

function commit(change) {
  finishInteractions();
  pushHistory(snapshot());
  change();
  collectUnusedAssets();
  queueSave();
  render();
}

function undo() {
  finishInteractions();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state = undoStack.pop();
  selectedId = pendingAssetId = null;
  queueSave();
  render();
}

function redo() {
  finishInteractions();
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state = redoStack.pop();
  selectedId = pendingAssetId = null;
  queueSave();
  render();
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveState() {
  const saved = structuredClone(encodeSession(state, undoStack, redoStack));
  try {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('state', 'readwrite');
        transaction.objectStore('state').put(saved, 'current');
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  } catch (error) {
    console.error('本地保存失败', error);
    showToast('本地空间不足或不可用，请先导出图片保存');
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 180);
}

async function loadState() {
  try {
    const db = await openDatabase();
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const session = decodeSession(stored);
    state = session.state;
    undoStack = session.undo;
    redoStack = session.redo;
  } catch (error) {
    console.warn('无法读取本地榜单', error);
    showToast('无法读取本地保存，本次编辑仍可导出');
  }
}

function labelFontSize(label) {
  const length = Array.from(label).length;
  return Math.min(120, (LABEL_WIDTH - 24) / Math.max(1, length));
}

function backgroundMarkup(boardState, bounds) {
  const rows = boardState.tiers.map((tier, index) => {
    const y = index * ROW_HEIGHT;
    const fontSize = labelFontSize(tier.label);
    return `<rect x="0" y="${y}" width="${LABEL_WIDTH}" height="${ROW_HEIGHT}" fill="${escapeHtml(tier.color)}" stroke="none"/>
      <text x="${LABEL_WIDTH / 2}" y="${y + ROW_HEIGHT / 2}" fill="#000" stroke="none" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif" font-size="${fontSize}" font-weight="400" text-anchor="middle" dominant-baseline="central">${escapeHtml(tier.label)}</text>
      <path d="M0 ${y} H${bounds.width}"/>`;
  }).join('');
  return `<rect x="0" y="${bounds.top}" width="${bounds.width}" height="${bounds.height}" fill="${BACKGROUND}"/>
    <g stroke="#111" stroke-width="${LINE_WIDTH}" fill="none">
      ${rows}
      <path d="M0 ${boardState.tiers.length * ROW_HEIGHT} H${bounds.width}"/>
      <path d="M${LABEL_WIDTH} ${bounds.top} V${bounds.bottom}"/>
    </g>`;
}

function renderAssets() {
  const assets = state.items.filter((item) => item.inLibrary !== false);
  elements.assetCount.textContent = assets.length;
  elements.assetList.innerHTML = assets.length ? assets.map((asset) => `
    <article class="asset-item ${pendingAssetId === asset.id ? 'selected' : ''}" draggable="true" data-asset-id="${asset.id}">
      <button class="asset-select" type="button" data-action="select-asset" aria-label="选择 ${escapeHtml(asset.name)}"><img class="asset-image" src="${asset.src}" alt="${escapeHtml(asset.name)}" draggable="false"/></button>
      <div class="asset-footer"><span class="asset-name" title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</span>
        <button class="item-action" data-action="edit-asset" type="button" aria-label="编辑 ${escapeHtml(asset.name)}" title="编辑候选图片"><i data-lucide="ellipsis"></i></button></div>
      <button class="asset-add" type="button" data-action="add-asset" aria-label="添加 ${escapeHtml(asset.name)} 到画布" title="添加到画布"><i data-lucide="plus"></i></button>
    </article>`).join('') : '<div class="empty-assets">粘贴截图，开始排位</div>';
}

function renderPlacements() {
  elements.placementLayer.innerHTML = state.placements.map((placement) => {
    const asset = assetById(placement.assetId);
    return `<div class="free-item" data-placement-id="${placement.id}" tabindex="0" role="button" aria-label="画布图片：${escapeHtml(asset.name)}">
      <img src="${asset.src}" alt="${escapeHtml(asset.name)}" draggable="false"/>
      <button class="canvas-remove" type="button" data-action="remove-placement" aria-label="从画布移除 ${escapeHtml(asset.name)}" title="从画布移除，保留候选图片"><i data-lucide="x"></i></button>
      ${['nw', 'ne', 'sw', 'se'].map((corner) => `<span class="resize-handle ${corner}" data-resize="${corner}" aria-hidden="true"></span>`).join('')}
    </div>`;
  }).join('');
}

function renderGeometry(frozenBounds = null) {
  const bounds = frozenBounds || layoutBounds(state);
  const scale = elements.boardViewport.clientWidth / BOARD_WIDTH;
  elements.rankBoard.style.width = `${bounds.width * scale}px`;
  elements.rankBoard.style.aspectRatio = `${bounds.width} / ${bounds.height}`;
  elements.boardBackground.setAttribute('viewBox', `0 ${bounds.top} ${bounds.width} ${bounds.height}`);
  const markup = backgroundMarkup(state, bounds);
  if (markup !== lastBackgroundMarkup) {
    elements.boardBackground.innerHTML = markup;
    lastBackgroundMarkup = markup;
  }
  const placements = new Map(state.placements.map((p) => [p.id, p]));
  elements.placementLayer.querySelectorAll('.free-item').forEach((node) => {
    const placement = placements.get(node.dataset.placementId);
    if (!placement) return;
    const asset = assetById(placement.assetId);
    node.style.left = `${placement.x / bounds.width * 100}%`;
    node.style.top = `${(placement.y - bounds.top) / bounds.height * 100}%`;
    node.style.width = `${placement.width / bounds.width * 100}%`;
    node.style.aspectRatio = `${asset.width} / ${asset.height}`;
    node.style.zIndex = String(10 + (placement.z || 0));
    node.classList.toggle('selected', placement.id === selectedId);
  });
  elements.rankBoard.classList.toggle('placement-ready', Boolean(pendingAssetId));
}

function renderSelection() {
  const placement = placementById(selectedId);
  const asset = assetById(placement?.assetId || pendingAssetId);
  elements.selectionBar.hidden = !asset;
  elements.removePlacementButton.hidden = !placement;
  elements.imageScale.closest('label').hidden = !placement;
  if (!asset) return;
  const preview = elements.selectionPreview.querySelector('img');
  if (!preview || preview.dataset.assetId !== asset.id) elements.selectionPreview.innerHTML = `<img src="${asset.src}" data-asset-id="${asset.id}" alt=""/>`;
  elements.selectionLabel.textContent = placement ? asset.name : '点击画布任意位置放置';
  if (placement) {
    const percent = Math.round(placement.width / defaultWidth(asset) * 100);
    elements.imageScale.max = String(Math.max(400, percent));
    elements.imageScale.value = String(percent);
    elements.scaleOutput.value = `${percent}%`;
  }
}

function render() {
  if (!placementById(selectedId)) selectedId = null;
  if (!assetById(pendingAssetId)) pendingAssetId = null;
  elements.undoButton.disabled = !undoStack.length;
  elements.redoButton.disabled = !redoStack.length;
  elements.retractTopButton.hidden = state.paddingTop === 0;
  elements.retractBottomButton.hidden = state.paddingBottom === 0;
  renderAssets();
  renderPlacements();
  renderGeometry();
  renderSelection();
  icons();
}

function selectPlacement(id) {
  selectedId = id;
  pendingAssetId = null;
  renderGeometry();
  renderSelection();
}

function pointOnBoard(clientX, clientY) {
  const rect = elements.rankBoard.getBoundingClientRect();
  const bounds = layoutBounds(state);
  const scale = rect.width / bounds.width;
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale + bounds.top };
}

function defaultPosition() {
  const bounds = layoutBounds(state);
  const rect = elements.rankBoard.getBoundingClientRect();
  const scale = rect.width / bounds.width;
  const visibleTop = Math.max(80, rect.top);
  const visibleBottom = Math.min(window.innerHeight - 100, rect.bottom);
  const y = visibleBottom > visibleTop ? ((visibleTop + visibleBottom) / 2 - rect.top) / scale + bounds.top : ROW_HEIGHT / 2;
  return { y: Math.floor(y / ROW_HEIGHT) * ROW_HEIGHT + ROW_HEIGHT / 2 };
}

function createPlacement(asset, position = findOpenPosition(state, asset, defaultPosition())) {
  return constrainPlacement({ id: uid('placed'), assetId: asset.id, width: defaultWidth(asset), z: nextZ(), ...position }, asset);
}

function addPlacement(assetId, position) {
  const asset = assetById(assetId);
  if (!asset) return;
  commit(() => {
    const placement = createPlacement(asset, position);
    state.placements.push(placement);
    selectedId = placement.id;
    pendingAssetId = null;
  });
  revealSelection();
}

function revealSelection() {
  elements.placementLayer.querySelector(`[data-placement-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function removePlacement(id) {
  if (!placementById(id)) return;
  commit(() => {
    state.placements = state.placements.filter((item) => item.id !== id);
    if (selectedId === id) selectedId = null;
  });
  showToast('已从画布移除，候选图片仍保留');
}

function imageFromUrl(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}

async function processImageFile(file) {
  const src = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const image = await imageFromUrl(src);
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效');
  return { id: uid(), name: (file.name || '截图').replace(/\.[^.]+$/, '') || '截图', src, width: image.naturalWidth, height: image.naturalHeight, inLibrary: true };
}

function addFiles(fileList, position) {
  const files = [...fileList].filter((file) => file.type.startsWith('image/'));
  if (!files.length) return showToast('请选择图片文件');
  importQueue = importQueue.then(async () => {
    elements.uploadZone.classList.add('busy');
    const results = await Promise.allSettled(files.map(processImageFile));
    const assets = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    if (assets.length) {
      const anchor = position || defaultPosition();
      commit(() => {
        state.items.push(...assets);
        assets.forEach((asset) => {
          const point = findOpenPosition(state, asset, anchor);
          const placement = createPlacement(asset, point);
          state.placements.push(placement);
          selectedId = placement.id;
        });
        pendingAssetId = null;
      });
      revealSelection();
    }
    const failures = files.length - assets.length;
    showToast(failures ? `已添加 ${assets.length} 张，${failures} 张无法读取` : `已添加 ${assets.length} 张到候选区和画布`);
    elements.uploadZone.classList.remove('busy');
    elements.fileInput.value = '';
  }).catch((error) => {
    console.error(error);
    elements.uploadZone.classList.remove('busy');
    showToast('图片导入失败，请重试');
  });
  return importQueue;
}

function openItemEditor(id) {
  const asset = assetById(id);
  if (!asset) return;
  editingAssetId = id;
  elements.itemNameInput.value = asset.name;
  elements.itemModal.showModal();
  elements.itemNameInput.select();
}

function renderTierEditor() {
  elements.tierEditor.innerHTML = tierDraft.map((tier, index) => `
    <div class="tier-edit-row" data-tier-id="${tier.id}">
      <input class="color-input" type="color" value="${tier.color}" aria-label="评级颜色" data-field="color"/>
      <input class="text-input" value="${escapeHtml(tier.label)}" maxlength="12" aria-label="评级名称" data-field="label" required/>
      <div class="row-actions">
        <button class="icon-button" type="button" data-tier-action="up" aria-label="上移评级" ${index === 0 ? 'disabled' : ''}><i data-lucide="chevron-up"></i></button>
        <button class="icon-button" type="button" data-tier-action="down" aria-label="下移评级" ${index === tierDraft.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-down"></i></button>
        <button class="icon-button" type="button" data-tier-action="remove" aria-label="删除评级" ${tierDraft.length === 1 ? 'disabled' : ''}><i data-lucide="trash-2"></i></button>
      </div>
    </div>`).join('');
  elements.addTierButton.disabled = elements.addTopTierButton.disabled = tierDraft.length >= 12;
  icons();
}

function addTier(atTop) {
  if (tierDraft.length >= 12) return;
  const tier = { id: uid('tier'), label: '', color: '#ffffff' };
  if (atTop) tierDraft.unshift(tier); else tierDraft.push(tier);
  renderTierEditor();
  const row = elements.tierEditor.querySelector(`[data-tier-id="${tier.id}"]`);
  row.querySelector('[data-field="label"]').focus();
}

function extendCanvas(top) {
  const bounds = layoutBounds(state);
  commit(() => {
    if (top) state.paddingTop = Math.max(state.paddingTop, -bounds.top) + ROW_HEIGHT / 2;
    else state.paddingBottom = Math.max(state.paddingBottom, bounds.bottom - state.tiers.length * ROW_HEIGHT) + ROW_HEIGHT / 2;
  });
}

function retractCanvas(top) {
  commit(() => retractPadding(state, top));
  showToast('已收回留白，图片位置保持不变');
}

async function buildBoardImage() {
  finishInteractions();
  await importQueue;
  await document.fonts.ready;
  const exported = snapshot();
  const bounds = layoutBounds(exported);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="0 ${bounds.top} ${bounds.width} ${bounds.height}">${backgroundMarkup(exported, bounds)}</svg>`;
  const backgroundUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  let background;
  try { background = await imageFromUrl(backgroundUrl); } finally { URL.revokeObjectURL(backgroundUrl); }
  const usedIds = new Set(exported.placements.map((p) => p.assetId));
  const sources = await Promise.all(exported.items.filter((asset) => usedIds.has(asset.id)).map(async (asset) => [asset.id, await imageFromUrl(asset.src)]));
  const images = new Map(sources);
  const assets = new Map(exported.items.map((asset) => [asset.id, asset]));
  // The same world rectangle drives preview, copy and export. No frame,
  // filename, selection controls, heading, date or watermark is included.
  const scale = Math.min(1600 / BOARD_WIDTH, 16000 / bounds.width, 16000 / bounds.height, Math.sqrt(48_000_000 / (bounds.width * bounds.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bounds.width * scale);
  canvas.height = Math.ceil(bounds.height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.drawImage(background, 0, 0, bounds.width, bounds.height);
  context.translate(0, -bounds.top);
  for (const placement of [...exported.placements].sort((a, b) => a.z - b.z)) {
    const size = imageSize(placement, assets.get(placement.assetId));
    context.drawImage(images.get(placement.assetId), placement.x - size.width / 2, placement.y - size.height / 2, size.width, size.height);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('无法生成 PNG');
  return blob;
}

async function exportBoard() {
  if (elements.exportButton.disabled) return;
  elements.exportButton.disabled = true;
  elements.exportButton.querySelector('span').textContent = '生成中';
  try {
    const blob = await buildBoardImage();
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportBlob = blob;
    exportUrl = URL.createObjectURL(blob);
    elements.exportPreview.src = exportUrl;
    const canChooseLocation = typeof window.showSaveFilePicker === 'function';
    elements.saveExportButton.textContent = canChooseLocation ? '选择位置保存并复制' : '下载并复制';
    elements.exportHelp.textContent = canChooseLocation
      ? '保存 PNG 的同时复制到剪贴板，可直接粘贴到聊天或文档。'
      : '此浏览器不支持网页选择保存位置。可右键预览图选择“图片另存为”，或在浏览器下载设置中开启“每次询问保存位置”。';
    elements.exportStatus.textContent = '';
    elements.exportModal.showModal();
  } catch (error) {
    console.error('导出失败', error);
    showToast('导出失败，请检查图片后重试');
  } finally {
    elements.exportButton.disabled = false;
    elements.exportButton.querySelector('span').textContent = '导出图片';
  }
}

function copyImage(blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('浏览器不支持图片复制');
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

async function copyBoard() {
  if (elements.copyBoardButton.disabled) return;
  elements.copyBoardButton.disabled = true;
  elements.copyBoardButton.querySelector('span').textContent = '复制中';
  try {
    const image = buildBoardImage();
    image.catch(() => {});
    // Request clipboard access during the click, before rendering finishes.
    await copyImage(image);
    showToast('已复制完整榜单，可直接粘贴');
  } catch (error) {
    console.error('复制失败', error);
    showToast('复制失败，请检查剪贴板权限或在导出预览中重试');
  } finally {
    elements.copyBoardButton.disabled = false;
    elements.copyBoardButton.querySelector('span').textContent = '复制图片';
  }
}

function downloadImage(blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = '夯到拉.png';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function saveExport() {
  if (!exportBlob || elements.saveExportButton.disabled) return;
  elements.saveExportButton.disabled = elements.copyExportButton.disabled = true;
  elements.exportStatus.textContent = '正在保存…';
  const hasPicker = typeof window.showSaveFilePicker === 'function';
  try {
    const { copied } = await saveAndCopyImage(exportBlob, {
      pickFile: hasPicker ? (options) => window.showSaveFilePicker(options) : null,
      copyImage,
      download: downloadImage,
    });
    elements.exportStatus.textContent = `${hasPicker ? '已保存' : '已开始下载'}${copied ? '，并已复制到剪贴板' : '；复制未成功，可点击“复制图片”重试'}`;
  } catch (error) {
    elements.exportStatus.textContent = error.name === 'AbortError' ? '已取消保存，没有下载文件' : '保存失败，请重试；也可右键预览图另存为';
  } finally {
    elements.saveExportButton.disabled = elements.copyExportButton.disabled = false;
  }
}

elements.saveExportButton.addEventListener('click', saveExport);
elements.copyExportButton.addEventListener('click', async () => {
  try {
    await copyImage(exportBlob);
    elements.exportStatus.textContent = '已复制图片，可直接粘贴';
  } catch {
    elements.exportStatus.textContent = '复制失败，请允许剪贴板权限，或右键预览图复制';
  }
});
elements.closeExportButton.addEventListener('click', () => elements.exportModal.close());

elements.fileInput.addEventListener('change', (event) => addFiles(event.target.files));
document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
});
for (const zone of [elements.uploadZone, elements.rankBoard]) {
  zone.addEventListener('dragover', (event) => {
    if (!draggingAssetId && ![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', (event) => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    const point = zone === elements.rankBoard ? pointOnBoard(event.clientX, event.clientY) : undefined;
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files, point);
    else if (draggingAssetId && zone === elements.rankBoard) addPlacement(draggingAssetId, point);
  });
}
elements.assetList.addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-asset-id]');
  if (!card) return;
  draggingAssetId = card.dataset.assetId;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('text/plain', draggingAssetId);
  card.classList.add('dragging');
});
document.addEventListener('dragend', () => {
  draggingAssetId = null;
  document.querySelectorAll('.dragging, .drag-over').forEach((node) => node.classList.remove('dragging', 'drag-over'));
});
elements.assetList.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  const id = event.target.closest('[data-asset-id]')?.dataset.assetId;
  if (!id) return;
  if (action === 'edit-asset') return openItemEditor(id);
  if (action === 'add-asset') return addPlacement(id);
  if (action === 'select-asset') {
    pendingAssetId = pendingAssetId === id ? null : id;
    selectedId = null;
    renderAssets();
    renderGeometry();
    renderSelection();
    icons();
  }
});

elements.rankBoard.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || pointerDrag) return;
  const node = event.target.closest('[data-placement-id]');
  if (!node || event.target.closest('button')) return;
  event.preventDefault();
  const placement = placementById(node.dataset.placementId);
  const asset = assetById(placement.assetId);
  const corner = event.target.closest('[data-resize]')?.dataset.resize;
  const size = imageSize(placement, asset);
  const signX = corner?.includes('w') ? -1 : 1;
  const signY = corner?.includes('n') ? -1 : 1;
  selectPlacement(placement.id);
  pointerDrag = {
    id: placement.id, pointerId: event.pointerId, before: snapshot(), start: { ...placement }, node,
    startX: event.clientX, startY: event.clientY, scale: elements.rankBoard.clientWidth / layoutBounds(state).width,
    bounds: layoutBounds(state), corner, signX, signY, moved: false,
    anchorX: placement.x - signX * size.width / 2, anchorY: placement.y - signY * size.height / 2,
    scrollY: window.scrollY, scrollX: elements.boardViewport.scrollLeft,
  };
  elements.rankBoard.setPointerCapture(event.pointerId);
});
elements.rankBoard.addEventListener('pointermove', (event) => {
  if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
  const drag = pointerDrag;
  const dx = (event.clientX - drag.startX + elements.boardViewport.scrollLeft - drag.scrollX) / drag.scale;
  const dy = (event.clientY - drag.startY + window.scrollY - drag.scrollY) / drag.scale;
  if (Math.hypot(dx, dy) * drag.scale < 3 && !drag.moved) return;
  drag.moved = true;
  drag.node.classList.add('moving');
  const placement = placementById(drag.id);
  const asset = assetById(placement.assetId);
  if (drag.corner) {
    const ratio = asset.height / asset.width;
    const delta = (drag.signX * dx + ratio * drag.signY * dy) / (1 + ratio * ratio);
    const adjusted = constrainPlacement({ ...placement, width: drag.start.width + delta }, asset);
    const size = imageSize(adjusted, asset);
    Object.assign(placement, constrainPlacement({ ...adjusted, x: drag.anchorX + drag.signX * size.width / 2, y: drag.anchorY + drag.signY * size.height / 2 }, asset));
  } else {
    Object.assign(placement, constrainPlacement({ ...placement, x: drag.start.x + dx, y: drag.start.y + dy }, asset));
  }
  const liveBounds = layoutBounds(state);
  // Keep the drag origin fixed; grow the right/bottom edge during the gesture.
  renderGeometry({ ...drag.bounds, width: Math.max(drag.bounds.width, liveBounds.width), bottom: Math.max(drag.bounds.bottom, liveBounds.bottom), height: Math.max(drag.bounds.bottom, liveBounds.bottom) - drag.bounds.top });
  renderSelection();
});
function finishPointer(event) {
  if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
  const drag = pointerDrag;
  pointerDrag = null;
  if (elements.rankBoard.hasPointerCapture(event.pointerId)) elements.rankBoard.releasePointerCapture(event.pointerId);
  suppressClickUntil = performance.now() + 200;
  if (event.type === 'pointercancel') state = drag.before;
  else if (drag.moved) {
    pushHistory(drag.before);
    placementById(drag.id).z = nextZ();
    queueSave();
  }
  render();
}
elements.rankBoard.addEventListener('pointerup', finishPointer);
elements.rankBoard.addEventListener('pointercancel', finishPointer);
elements.rankBoard.addEventListener('lostpointercapture', finishPointer);
window.addEventListener('blur', () => finishInteractions());
elements.rankBoard.addEventListener('click', (event) => {
  const node = event.target.closest('[data-placement-id]');
  if (event.target.closest('[data-action="remove-placement"]')) return removePlacement(node.dataset.placementId);
  if (node || performance.now() < suppressClickUntil) return;
  if (pendingAssetId) addPlacement(pendingAssetId, pointOnBoard(event.clientX, event.clientY));
  else selectPlacement(null);
});

elements.imageScale.addEventListener('input', () => {
  const placement = placementById(selectedId);
  if (!placement) return;
  if (!sliderBefore) sliderBefore = snapshot();
  const asset = assetById(placement.assetId);
  Object.assign(placement, constrainPlacement({ ...placement, width: defaultWidth(asset) * Number(elements.imageScale.value) / 100 }, asset));
  renderGeometry();
  renderSelection();
});
function finishSlider() {
  if (!sliderBefore) return;
  pushHistory(sliderBefore);
  sliderBefore = null;
  queueSave();
  render();
}
function finishInteractions() {
  if (pointerDrag) finishPointer({ pointerId: pointerDrag.pointerId, type: 'pointerup' });
  finishSlider();
}
elements.imageScale.addEventListener('change', finishSlider);
elements.imageScale.addEventListener('blur', finishSlider);
elements.removePlacementButton.addEventListener('click', () => removePlacement(selectedId));
elements.clearSelectionButton.addEventListener('click', () => {
  selectedId = pendingAssetId = null;
  render();
});
elements.extendTopButton.addEventListener('click', () => extendCanvas(true));
elements.extendBottomButton.addEventListener('click', () => extendCanvas(false));
elements.retractTopButton.addEventListener('click', () => retractCanvas(true));
elements.retractBottomButton.addEventListener('click', () => retractCanvas(false));
elements.undoButton.addEventListener('click', undo);
elements.redoButton.addEventListener('click', redo);
elements.exportButton.addEventListener('click', exportBoard);
elements.copyBoardButton.addEventListener('click', copyBoard);

elements.itemForm.addEventListener('submit', (event) => {
  if (event.submitter?.value !== 'default') return;
  event.preventDefault();
  const name = elements.itemNameInput.value.trim();
  if (!name) return elements.itemNameInput.focus();
  commit(() => { assetById(editingAssetId).name = name; });
  elements.itemModal.close();
});
elements.deleteItemButton.addEventListener('click', () => {
  commit(() => {
    assetById(editingAssetId).inLibrary = false;
    if (pendingAssetId === editingAssetId) pendingAssetId = null;
  });
  elements.itemModal.close();
  showToast('已从候选区删除，画布中的图片保留');
});
elements.tierSettingsButton.addEventListener('click', () => {
  tierDraft = structuredClone(state.tiers);
  renderTierEditor();
  elements.tierModal.showModal();
});
elements.tierEditor.addEventListener('input', (event) => {
  const tier = tierDraft.find((item) => item.id === event.target.closest('[data-tier-id]')?.dataset.tierId);
  if (tier && ['color', 'label'].includes(event.target.dataset.field)) tier[event.target.dataset.field] = event.target.value;
});
elements.tierEditor.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tier-action]');
  if (!button) return;
  const index = tierDraft.findIndex((tier) => tier.id === button.closest('[data-tier-id]').dataset.tierId);
  if (button.dataset.tierAction === 'up' && index > 0) [tierDraft[index - 1], tierDraft[index]] = [tierDraft[index], tierDraft[index - 1]];
  if (button.dataset.tierAction === 'down' && index < tierDraft.length - 1) [tierDraft[index + 1], tierDraft[index]] = [tierDraft[index], tierDraft[index + 1]];
  if (button.dataset.tierAction === 'remove' && tierDraft.length > 1) tierDraft.splice(index, 1);
  renderTierEditor();
});
elements.addTopTierButton.addEventListener('click', () => addTier(true));
elements.addTierButton.addEventListener('click', () => addTier(false));
elements.tierForm.addEventListener('submit', (event) => {
  if (event.submitter?.value !== 'default') return;
  event.preventDefault();
  if (tierDraft.some((tier) => !tier.label.trim())) return showToast('请填写评级名称');
  commit(() => {
    const offset = tierDraft.findIndex((tier) => tier.id === state.tiers[0].id);
    // A new rating above the old first row occupies the previous top extension;
    // existing images stay in the same relative rating positions.
    if (offset > 0 && tierDraft.slice(0, offset).every((tier) => !state.tiers.some((old) => old.id === tier.id))) {
      state.placements.forEach((p) => { p.y += offset * ROW_HEIGHT; });
      state.paddingTop = Math.max(0, state.paddingTop - offset * ROW_HEIGHT);
    }
    state.tiers = tierDraft.map((tier) => ({ ...tier, label: tier.label.trim() }));
  });
  elements.tierModal.close();
});

document.addEventListener('keydown', (event) => {
  if (event.target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]') || elements.tierModal.open || elements.itemModal.open || elements.exportModal.open) return;
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    return event.shiftKey ? redo() : undo();
  }
  if (event.target.closest('input[type="range"]')) return;
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
    event.preventDefault();
    return removePlacement(selectedId);
  }
  if (event.key === 'Escape') {
    selectedId = pendingAssetId = null;
    render();
  }
  const node = event.target.closest('[data-placement-id]');
  if (node && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    selectPlacement(node.dataset.placementId);
  }
  if (selectedId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    commit(() => {
      const p = placementById(selectedId);
      const step = event.shiftKey ? 20 : 2;
      p.x += event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
      p.y += event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
      Object.assign(p, constrainPlacement(p, assetById(p.assetId)));
    });
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    finishInteractions();
    clearTimeout(saveTimer);
    saveState();
  }
});
window.addEventListener('pagehide', () => {
  finishInteractions();
  clearTimeout(saveTimer);
  saveState();
});

await loadState();
render();
new ResizeObserver(() => { if (!pointerDrag) renderGeometry(); }).observe(elements.boardViewport);
