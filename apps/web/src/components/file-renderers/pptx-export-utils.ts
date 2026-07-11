/** Ensure a downloaded presentation always carries a `.pptx` extension. */
export function resolvePptxFileName(fileName: string): string {
  return fileName.toLowerCase().endsWith('.pptx') ? fileName : `${fileName}.pptx`;
}
