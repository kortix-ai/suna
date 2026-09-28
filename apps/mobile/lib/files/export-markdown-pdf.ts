/**
 * exportMarkdownPdf — renders a markdown file's text to `<name>.pdf` in the
 * cache directory and returns its URI (KRTX-605).
 *
 * `expo-print` draws the HTML in the platform web view and prints it to a PDF.
 * It is in Expo Go; a development or store build needs a native rebuild to
 * include it. `runtimeVersion` is a fixed string, so an OTA update can reach a
 * binary built before it: the module is required only when `ExpoPrint` is in
 * the running binary, otherwise the result is `null` (the caller says to
 * update the app).
 */
import { requireOptionalNativeModule } from 'expo';
import * as FileSystem from 'expo-file-system/legacy';
import { MarkdownIt } from 'react-native-markdown-display';

import { markdownPrintHtml, pdfFileName, PRINT_MARKDOWN_OPTIONS } from './markdown-export';

/** Created on first export: most sessions never make a PDF. */
let printMarkdown: ReturnType<typeof MarkdownIt> | null = null;

/** iOS page margins in points (Android reads the stylesheet's `@page`). */
const IOS_MARGINS = { top: 50, bottom: 50, left: 46, right: 46 };

export async function exportMarkdownPdf(markdown: string, fileName: string): Promise<string | null> {
  if (requireOptionalNativeModule('ExpoPrint') == null) return null;
  const Print = require('expo-print') as typeof import('expo-print');
  printMarkdown ??= MarkdownIt(PRINT_MARKDOWN_OPTIONS);
  const { uri } = await Print.printToFileAsync({
    html: markdownPrintHtml(markdown, fileName, printMarkdown),
    margins: IOS_MARGINS,
  });
  // expo-print names the file with a random UUID; the share sheet and the
  // device's PDF app show this name, so it is the markdown file's own.
  const target = `${FileSystem.cacheDirectory}${pdfFileName(fileName)}`;
  await FileSystem.deleteAsync(target, { idempotent: true });
  await FileSystem.moveAsync({ from: uri, to: target });
  return target;
}
