import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_WIDTH, LABEL_WIDTH, ROW_HEIGHT, createState, defaultWidth, imageSize, constrainPlacement, layoutBounds, migrateState, findOpenPosition, retractPadding } from '../board-model.mjs';
import { encodeSession, decodeSession } from '../editor-session.mjs';

test('portrait, landscape and square images retain every edge at every scale', () => {
  for (const [width, height] of [[1200, 300], [200, 1600], [500, 500], [100, 12000]]) {
    const asset = { id: 'a', width, height };
    for (const scale of [.1, 1, 2, 4]) {
      for (const y of [-700, 120, 1600, 3000]) {
        const p = constrainPlacement({ id: 'p', assetId: 'a', x: 1200, y, width: defaultWidth(asset) * scale }, asset);
        const board = { ...createState(), items: [asset], placements: [p] };
        const size = imageSize(p, asset);
        const bounds = layoutBounds(board);
        assert.ok(Math.abs(size.width / size.height - width / height) < 1e-10);
        assert.ok(p.y - size.height / 2 >= bounds.top);
        assert.ok(p.y + size.height / 2 <= bounds.bottom);
        assert.ok(p.x - size.width / 2 >= LABEL_WIDTH);
        assert.ok(p.x + size.width / 2 <= bounds.width);
      }
    }
  }
});

test('many images extend to the right without overlap or changing their chosen rating', () => {
  const board = createState();
  for (let i = 0; i < 40; i++) {
    const asset = { id: `a${i}`, width: i % 2 ? 1200 : 200, height: i % 2 ? 300 : 1600 };
    board.items.push(asset);
    const point = findOpenPosition(board, asset, { y: ROW_HEIGHT * 1.5 });
    const placement = constrainPlacement({ id: `p${i}`, assetId: asset.id, width: defaultWidth(asset), ...point }, asset);
    for (const old of board.placements) assert.ok(placement.x - placement.width / 2 >= old.x + old.width / 2 + 19.99);
    assert.equal(placement.y, ROW_HEIGHT * 1.5);
    board.placements.push(placement);
  }
  const bounds = layoutBounds(board);
  assert.ok(bounds.width > BOARD_WIDTH * 4);
  assert.equal(bounds.top, 0);
  assert.equal(bounds.bottom, ROW_HEIGHT * 5);
  const reloaded = migrateState(board);
  assert.deepEqual(reloaded.placements, board.placements);
});

test('retract only removes manual padding and never crops or moves images', () => {
  const board = createState();
  board.paddingTop = 420;
  board.paddingBottom = 280;
  board.items = [{ id: 'a', width: 100, height: 200 }];
  board.placements = [{ id: 'p', assetId: 'a', x: 1800, y: -140, width: 100 }];
  const original = structuredClone(board.placements);
  retractPadding(board, true);
  assert.equal(board.paddingTop, 0);
  assert.equal(board.paddingBottom, 280);
  assert.equal(layoutBounds(board).top, -248);
  retractPadding(board, false);
  assert.equal(layoutBounds(board).bottom, ROW_HEIGHT * 5);
  assert.deepEqual(board.placements, original);
  board.placements = [];
  assert.equal(layoutBounds(board).top, 0);
});

test('reload preserves undo and redo, deduplicating images including removed assets', () => {
  const initial = createState();
  const expanded = structuredClone(initial);
  expanded.paddingTop = 140;
  expanded.items = [{ id: 'a', name: 'test', width: 100, height: 100, src: 'data:image/png;base64,abc', inLibrary: true }];
  const edited = structuredClone(expanded);
  edited.placements = [{ id: 'p', assetId: 'a', width: 100, x: 2000, y: -100, z: 1 }];
  const stored = encodeSession(initial, [initial, expanded], [edited]);
  assert.equal(stored.sources.length, 1);
  assert.equal(JSON.stringify(stored).split(expanded.items[0].src).length - 1, 1);
  const restored = decodeSession(structuredClone(stored));
  assert.deepEqual(restored.state, initial);
  assert.deepEqual(restored.undo.pop(), expanded);
  assert.deepEqual(restored.undo.pop(), initial);
  assert.deepEqual(restored.redo.pop(), edited);
});

test('v4 boards preserve user content and can retract old expansion without history', () => {
  const old = { ...createState(), version: 4, paddingTop: 280 };
  const restored = decodeSession(old);
  assert.equal(restored.state.paddingTop, 280);
  assert.deepEqual(restored.undo, []);
  retractPadding(restored.state, true);
  assert.equal(layoutBounds(restored.state).top, 0);
});

test('manual extensions add blank space without shifting image coordinates', () => {
  const board = createState();
  board.paddingTop = 140;
  board.paddingBottom = 280;
  assert.deepEqual(layoutBounds(board), { top: -140, bottom: 1680, height: 1820, width: 1290 });
});

test('legacy content migrates to independent placements without resetting the library', () => {
  const old = {
    items: [{ id: 'a', name: 'existing', src: 'data:image/png;base64,abc', width: 200, height: 400, x: .6, y: .5 }, { id: 'b', width: 400, height: 100 }],
    tiers: ['夯', '顶级', '还行', '一般', '拉'].map((label, i) => ({ id: `t${i}`, label, color: '#fff' })),
  };
  const migrated = migrateState(old);
  assert.equal(migrated.items.length, 2);
  assert.equal(migrated.placements.length, 1);
  assert.equal(migrated.items[0].src, old.items[0].src);
  assert.deepEqual(migrated.tiers.map((t) => t.label), ['夯', '顶级', '人上人', 'NPC', '拉完了']);
  migrated.placements = [];
  assert.equal(migrated.items.filter((item) => item.inLibrary).length, 2);
});

test('custom ratings, individual image sizes, and hidden library items survive reload', () => {
  const board = createState();
  board.tiers[0].label = '自定义';
  board.items = [{ id: 'a', name: 'test', src: 'data:image/png;base64,abc', width: 800, height: 200, inLibrary: false }];
  board.placements = [{ id: 'p', assetId: 'a', x: 700, y: ROW_HEIGHT - 17, width: 360, z: 2 }];
  assert.deepEqual(migrateState(board), board);
});
