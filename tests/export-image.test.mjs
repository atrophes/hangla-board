import test from 'node:test';
import assert from 'node:assert/strict';
import { saveAndCopyImage } from '../export-image.mjs';

test('save chooses one file, copies identical PNG after saving, and never also downloads', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  const calls = [];
  let copied;
  const operation = saveAndCopyImage(blob, {
    pickFile: () => {
      calls.push('picker');
      return Promise.resolve({ createWritable: async () => ({
        write: async (data) => { assert.equal(data, blob); calls.push('write'); },
        close: async () => { calls.push('close'); },
      }) });
    },
    copyImage: async (data) => { calls.push('clipboard-request'); copied = await data; calls.push('copy'); },
    download: () => assert.fail('must not also download'),
  });
  assert.deepEqual(calls, ['clipboard-request', 'picker']);
  assert.deepEqual(await operation, { copied: true });
  assert.equal(copied, blob);
  assert.deepEqual(calls, ['clipboard-request', 'picker', 'write', 'close', 'copy']);
});

test('canceling location selection produces neither download nor clipboard data', async () => {
  let consumed = false;
  await assert.rejects(saveAndCopyImage(new Blob(), {
    pickFile: () => Promise.reject(new DOMException('Canceled', 'AbortError')),
    copyImage: async (data) => { await data; consumed = true; },
    download: () => assert.fail('cancellation must not fall back to downloading'),
  }), { name: 'AbortError' });
  assert.equal(consumed, false);
});

test('clipboard permission failure does not prevent saving', async () => {
  let downloads = 0;
  const result = await saveAndCopyImage(new Blob(), {
    copyImage: () => { throw new Error('permission denied'); },
    download: () => downloads++,
  });
  assert.deepEqual(result, { copied: false });
  assert.equal(downloads, 1);
});
