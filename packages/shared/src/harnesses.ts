/** Ordered harness identifiers. The order is stable for product surfaces. */
export const HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export interface HarnessDescriptor {
  id: HarnessId;
  label: string;
  configDir: string;
  adapterPackage: string;
  stability: 'stable' | 'experimental';
  modelNamespacing: 'gateway-prefixed' | 'bare';
  ownsDefaultModel: boolean;
  liveModelChange: boolean;
}

/** Canonical harness metadata shared by API, manifest, web, and mobile code. */
export const HARNESSES: Record<HarnessId, HarnessDescriptor> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    configDir: '.claude',
    adapterPackage: '@agentclientprotocol/claude-agent-acp',
    stability: 'experimental',
    modelNamespacing: 'bare',
    ownsDefaultModel: true,
    liveModelChange: false,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    configDir: '.codex',
    adapterPackage: '@agentclientprotocol/codex-acp',
    stability: 'experimental',
    modelNamespacing: 'bare',
    ownsDefaultModel: true,
    liveModelChange: false,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    configDir: '.kortix/opencode',
    adapterPackage: 'opencode-ai',
    stability: 'stable',
    modelNamespacing: 'gateway-prefixed',
    ownsDefaultModel: false,
    liveModelChange: true,
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    configDir: '.pi',
    adapterPackage: 'pi-acp',
    stability: 'experimental',
    modelNamespacing: 'bare',
    ownsDefaultModel: false,
    liveModelChange: false,
  },
};

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}
