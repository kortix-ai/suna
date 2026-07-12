import type { AcpHarness, RuntimeProfile } from '@kortix/sdk/projects-client';

export const ACP_HARNESSES: readonly AcpHarness[] = ['claude', 'codex', 'opencode', 'pi'];
export const ACP_HARNESS_LABELS: Record<AcpHarness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};
export const ACP_HARNESS_CONFIG_DIRS: Record<AcpHarness, string> = {
  claude: '.claude',
  codex: '.codex',
  opencode: '.kortix/opencode',
  pi: '.pi',
};

export function withAllAcpHarnesses(
  current: Record<string, RuntimeProfile>,
): Record<string, RuntimeProfile> {
  const next = { ...current };
  for (const harness of ACP_HARNESSES) {
    if (!Object.values(next).some((profile) => profile.harness === harness)) {
      next[harness] = { harness, config_dir: ACP_HARNESS_CONFIG_DIRS[harness] };
    }
  }
  return next;
}
