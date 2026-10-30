// Start both browser permission-sensitive operations in the click handler.
// Clipboard data is only released after the selected file has been saved.
export async function saveAndCopyImage(blob, { pickFile, copyImage, download }) {
  let resolveClipboard;
  let rejectClipboard;
  const clipboardBlob = new Promise((resolve, reject) => {
    resolveClipboard = resolve;
    rejectClipboard = reject;
  });
  // Ask while the document still has focus, before the native picker opens.
  clipboardBlob.catch(() => {});
  let copied;
  try { copied = Promise.resolve(copyImage(clipboardBlob)).then(() => true, () => false); }
  catch { copied = Promise.resolve(false); }
  const saved = (async () => {
    if (pickFile) {
      const handle = await pickFile({
        suggestedName: '夯到拉.png',
        types: [{ description: 'PNG 图片', accept: { 'image/png': ['.png'] } }],
      });
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => {});
        throw error;
      }
    } else {
      download(blob);
    }
    return blob;
  })();
  try { resolveClipboard(await saved); }
  catch (error) { rejectClipboard(error); throw error; }
  return { copied: await copied };
}
