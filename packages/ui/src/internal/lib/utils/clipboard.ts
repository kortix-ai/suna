/**
 * Pass a Promise when the text is not ready yet (e.g. read from a worker):
 * the clipboard write then starts synchronously inside the user gesture,
 * which Safari requires, and resolves when the text does.
 */
export async function copyToClipboard(text: string | Promise<string>): Promise<boolean> {
  try {
    if (typeof text !== 'string' && typeof ClipboardItem !== 'undefined') {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    }
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}
