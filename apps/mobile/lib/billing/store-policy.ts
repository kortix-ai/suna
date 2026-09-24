/**
 * App Store guideline 3.1.1: an iOS app must not surface a button, link, or
 * other call to action that leads to purchasing digital goods or a
 * subscription outside Apple's in-app purchase.
 *
 * Mobile ships no in-app purchase — `shouldUseRevenueCat()` (./provider) is
 * hard-disabled — so on iOS every billing surface stays read-only: no price
 * text, and no "Buy credits" / "Change plan" / "Upgrade" / "Manage on
 * kortix.com" action that opens web checkout. Android and web are unaffected;
 * checkout there still opens kortix.com in the browser.
 *
 * Pure so it has a plain `bun test`; pass `Platform.OS` in from the caller —
 * this module must not import react-native.
 */
export function canShowExternalPurchase(os: string): boolean {
  return os !== 'ios';
}
