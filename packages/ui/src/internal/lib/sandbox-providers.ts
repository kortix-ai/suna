/** Sandbox provider names, order and labels. Platinum is the reference provider. */

const PROVIDER_LABEL: Record<string, string> = {
  platinum: 'Platinum',
  daytona: 'Daytona',
};

/** Platinum is the reference provider. Daytona is a legacy fallback with removal scheduled. */
export function isLegacySandboxProvider(provider: string): boolean {
  return provider === 'daytona';
}

/** Sort key: Platinum first, legacy providers last. */
export function sandboxProviderRank(provider: string): number {
  return provider === 'platinum' ? 0 : isLegacySandboxProvider(provider) ? 2 : 1;
}

export function sortSandboxProviders<T extends string>(providers: readonly T[]): T[] {
  return [...providers].sort((a, b) => sandboxProviderRank(a) - sandboxProviderRank(b));
}

/** A value with no label (an old `e2b` row) shows raw. */
export function formatSandboxProvider(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/** `Platinum`, `Platinum and Daytona`. */
export function formatSandboxProviders(providers: readonly string[]): string {
  const names = sortSandboxProviders(providers).map(formatSandboxProvider);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
