/**
 * The "Includes" list rendered by the global upgrade sheet
 * (`components/billing/GlobalUpgradeSheet.tsx`). Pure so the iOS branch has
 * a `bun test` without pulling react-native into this module.
 *
 * iOS (App Store guideline 3.1.1 — no link to purchase outside IAP, and no
 * price shown for something that can't be bought in the app): the sheet
 * shows no price anywhere, including here — the first line drops the
 * per-seat dollar amount. Android and web keep it.
 */
export function getUpgradeSheetIncludedItems(pricePerSeat: number, canPurchase: boolean): string[] {
  return [
    canPurchase
      ? `$${pricePerSeat} of usage credit per teammate, every month`
      : 'Usage credit for every teammate, every month',
    'Every model, drawn from one shared team wallet',
    'AI Computers to run code, browsers, and terminals',
    'Spend on compute, LLM, or both, with auto top-up',
    'Auto-prorated as teammates join or leave',
  ];
}
