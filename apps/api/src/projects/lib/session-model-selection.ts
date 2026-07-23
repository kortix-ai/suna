export function requiresExplicitModelSelection(input: {
  authType?: string | null;
  source?: string | null;
  ownsDefaultModel: boolean;
  hasExplicitSelection: boolean;
}): boolean {
  return (
    input.authType === 'supabase' &&
    input.source === 'ui' &&
    !input.ownsDefaultModel &&
    !input.hasExplicitSelection
  );
}
