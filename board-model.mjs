export const BOARD_WIDTH = 1290;
export const LABEL_WIDTH = 318;
export const ROW_HEIGHT = 280;
export const LINE_WIDTH = 4;
export const BACKGROUND = '#c6c6c5';
export const CLASSIC_TIERS = [
  { id: 'tier-hang', label: '夯', color: '#ef3024' },
  { id: 'tier-top', label: '顶级', color: '#f4cc46' },
  { id: 'tier-human', label: '人上人', color: '#ffff00' },
  { id: 'tier-npc', label: 'NPC', color: '#faf0cc' },
  { id: 'tier-la', label: '拉完了', color: '#ffffff' },
];

export function createState() {
  return { version: 5, items: [], placements: [], tiers: structuredClone(CLASSIC_TIERS), paddingTop: 0, paddingBottom: 0 };
}

export function defaultWidth(asset) {
  return Math.min(260, 260 * asset.width / asset.height);
}

export function imageSize(placement, asset) {
  return { width: placement.width, height: placement.width * asset.height / asset.width };
}

export function constrainPlacement(placement, asset) {
  const maxWidth = Math.min(5600, 5600 * asset.width / asset.height);
  const minWidth = Math.min(24, maxWidth);
  const width = Math.max(minWidth, Math.min(maxWidth, placement.width));
  return {
    ...placement,
    width,
    x: Math.max(LABEL_WIDTH + 12 + width / 2, placement.x),
  };
}

export function layoutBounds(state) {
  let top = -state.paddingTop;
  let bottom = state.tiers.length * ROW_HEIGHT + state.paddingBottom;
  let width = BOARD_WIDTH;
  const assets = new Map(state.items.map((asset) => [asset.id, asset]));
  for (const placement of state.placements) {
    const asset = assets.get(placement.assetId);
    if (!asset) continue;
    const { height } = imageSize(placement, asset);
    // The entire source image contributes to the exported bounds, including
    // portions beyond the first or last rating.
    top = Math.min(top, placement.y - height / 2 - 8);
    bottom = Math.max(bottom, placement.y + height / 2 + 8);
    width = Math.max(width, placement.x + placement.width / 2 + 12);
  }
  top = Math.floor(top) || 0;
  bottom = Math.ceil(bottom);
  return { top, bottom, height: bottom - top, width: Math.ceil(width) };
}

// Keep new pictures in the chosen horizontal band. Make room to the right
// instead of silently assigning them to another rating or covering old images.
export function findOpenPosition(state, asset, { x, y = ROW_HEIGHT / 2 } = {}) {
  const width = defaultWidth(asset);
  const height = width * asset.height / asset.width;
  const gap = 20;
  let left = Math.max(LABEL_WIDTH + gap, (x ?? 0) - width / 2);
  const assets = new Map(state.items.map((item) => [item.id, item]));
  const obstacles = state.placements.flatMap((placement) => {
    const source = assets.get(placement.assetId);
    if (!source) return [];
    const size = imageSize(placement, source);
    if (Math.abs(placement.y - y) >= (height + size.height) / 2 + gap) return [];
    return [{ left: placement.x - size.width / 2, right: placement.x + size.width / 2 }];
  }).sort((a, b) => a.left - b.left);
  for (const obstacle of obstacles) {
    if (left + width + gap <= obstacle.left) break;
    if (left < obstacle.right + gap) left = obstacle.right + gap;
  }
  return { x: left + width / 2, y };
}

export function retractPadding(state, top) {
  state[top ? 'paddingTop' : 'paddingBottom'] = 0;
}

export function migrateState(stored) {
  if (!stored || !Array.isArray(stored.items)) return createState();
  const result = createState();
  result.items = stored.items.map((item) => ({
    id: item.id, name: item.name || '截图', src: item.src,
    width: Number(item.width) > 0 ? Number(item.width) : 1,
    height: Number(item.height) > 0 ? Number(item.height) : 1,
    inLibrary: item.inLibrary !== false,
  }));
  const oldDefault = ['夯', '顶级', '还行', '一般', '拉'];
  const hadDefaultTiers = stored.tiers?.length === oldDefault.length && stored.tiers.every((tier, i) => tier.label === oldDefault[i]);
  if (stored.tiers?.length && (stored.version >= 4 || !hadDefaultTiers)) {
    result.tiers = stored.tiers.map((tier) => ({ ...tier }));
  }
  if (stored.version >= 4) {
    result.paddingTop = Math.max(0, Number(stored.paddingTop) || 0);
    result.paddingBottom = Math.max(0, Number(stored.paddingBottom) || 0);
    result.placements = (stored.placements || []).map((item) => ({ ...item }));
  } else {
    const widths = { small: .14, medium: .18, large: .24 };
    result.placements = stored.items.filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y)).map((item) => ({
      id: `placed-${item.id}`, assetId: item.id,
      x: item.x * BOARD_WIDTH,
      y: ROW_HEIGHT / 2 + (item.y - .22) / .56 * ((result.tiers.length - 1) * ROW_HEIGHT),
      width: BOARD_WIDTH * (widths[stored.cardSize] || .18), z: item.z || 1,
    }));
  }
  const assets = new Map(result.items.map((item) => [item.id, item]));
  result.placements = result.placements.filter((p) => assets.has(p.assetId) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.width > 0)
    .map((p) => constrainPlacement(p, assets.get(p.assetId)));
  return result;
}
