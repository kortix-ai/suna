/** One tab of the channel bindings dialog: a platform and how many conversations it has bound. */
export interface BindingTab {
  platform: string;
  count: number;
}

const ORDER = ['slack', 'teams'];

/** A tab per platform with a binding: Slack, then Teams, then any other by name. */
export function bindingTabs(bindings: ReadonlyArray<{ platform: string }>): BindingTab[] {
  const counts = new Map<string, number>();
  for (const { platform } of bindings) counts.set(platform, (counts.get(platform) ?? 0) + 1);
  const rank = (platform: string) => {
    const at = ORDER.indexOf(platform);
    return at < 0 ? ORDER.length : at;
  };
  return [...counts]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => rank(a.platform) - rank(b.platform) || a.platform.localeCompare(b.platform));
}
