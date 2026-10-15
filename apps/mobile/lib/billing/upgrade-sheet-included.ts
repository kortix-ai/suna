/**
 * The "Includes" list rendered by the global upgrade sheet
 * (`components/billing/GlobalUpgradeSheet.tsx`) and the upgrade screen
 * (`app/welcome.tsx`). Pure so it has a `bun test` without pulling
 * react-native into this module. No price: the list reads the same on every
 * platform (App Store guideline 3.1.1 shows no price for what iOS cannot buy).
 */
export function getUpgradeSheetIncludedItems(): string[] {
  return [
    'Unlimited members, one shared credit pool',
    'Every model, drawn from the same credits',
    'AI Computers to run code, browsers, and terminals',
    'Spend on compute, LLM, or both, with auto top-up',
    'Unused monthly credits roll over one month',
  ];
}
