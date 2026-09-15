import { log } from '@/lib/logger';

export type LegalTab = 'privacy' | 'terms';

/** Opens kortix.com/legal on the given tab in an in-app browser sheet. */
export async function openLegalPage(tab: LegalTab): Promise<void> {
  try {
    const WebBrowser = await import('expo-web-browser');
    await WebBrowser.openBrowserAsync(`https://www.kortix.com/legal?tab=${tab}`, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    });
  } catch (error) {
    log.warn('Unable to open legal page:', error);
  }
}
