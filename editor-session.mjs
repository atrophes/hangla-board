import { createState, migrateState } from './board-model.mjs';

export const MAX_HISTORY = 30;

// Store each original image once, even when it appears in every undo snapshot.
export function encodeSession(state, undo, redo) {
  const sources = new Map();
  const pack = (entry) => ({
    ...entry,
    items: entry.items.map(({ src, ...asset }) => {
      sources.set(asset.id, src);
      return asset;
    }),
  });
  const session = {
    format: 'hangla-session-1',
    current: pack(state),
    undo: undo.slice(-MAX_HISTORY).map(pack),
    redo: redo.slice(-MAX_HISTORY).map(pack),
  };
  return { ...session, sources: [...sources] };
}

export function decodeSession(stored) {
  if (stored?.format !== 'hangla-session-1') {
    return { state: stored ? migrateState(stored) : createState(), undo: [], redo: [] };
  }
  const sources = new Map(stored.sources);
  const unpack = (entry) => migrateState({
    ...entry,
    items: entry.items.map((asset) => ({ ...asset, src: sources.get(asset.id) })),
  });
  return {
    state: unpack(stored.current),
    undo: (stored.undo || []).slice(-MAX_HISTORY).map(unpack),
    redo: (stored.redo || []).slice(-MAX_HISTORY).map(unpack),
  };
}
