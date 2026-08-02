export const AGENT_PROFILE_SECTIONS = [
  'instructions',
  'integrations',
  'knowledge',
  'skills',
  'automations',
  'advanced',
] as const;

export type AgentProfileSection = (typeof AGENT_PROFILE_SECTIONS)[number];
export type AgentProfileRisk = 'low' | 'medium' | 'high';
export type AgentProfileSections = Partial<Record<AgentProfileSection, unknown>>;

export interface AgentProfileImpact {
  data_access: string[];
  actions: string[];
  schedule_changes: string[];
  cost_sensitive_settings: string[];
}

export interface ClassifiedAgentProfileChange {
  section: AgentProfileSection;
  risk: AgentProfileRisk;
  kind: 'add' | 'update' | 'remove';
  summary: string;
}

export interface AgentProfileClassification {
  changedSections: AgentProfileSection[];
  changes: ClassifiedAgentProfileChange[];
  highestRisk: AgentProfileRisk;
  impact: AgentProfileImpact;
}

const RISK_RANK: Record<AgentProfileRisk, number> = { low: 0, medium: 1, high: 2 };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function changedRecords(before: unknown, after: unknown): Array<Record<string, unknown>> {
  const previous = asRecords(before);
  const next = asRecords(after);
  return [
    ...previous.filter((entry) => !next.some((candidate) => equal(entry, candidate))),
    ...next.filter((entry) => !previous.some((candidate) => equal(entry, candidate))),
  ];
}

function stringList(value: unknown): string[] {
  if (value === 'all') return ['all'];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').sort()
    : [];
}

function expanded(previous: unknown, next: unknown): boolean {
  if (next === 'all') return previous !== 'all';
  if (previous === 'all') return false;
  const before = new Set(stringList(previous));
  return stringList(next).some((entry) => !before.has(entry));
}

function add(set: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) set.add(value.trim());
}

function sectionRisk(
  section: AgentProfileSection,
  before: unknown,
  after: unknown,
): AgentProfileRisk {
  if (section === 'instructions') return 'low';
  if (section === 'knowledge' || section === 'skills') return 'medium';
  if (section === 'automations') return 'high';
  if (section === 'integrations') {
    return asRecords(after).some((integration) => {
      if (integration.can_write === true) return true;
      return stringList(integration.scopes).some((scope) =>
        /(^|[.:/_-])(write|create|update|delete|send|manage)($|[.:/_-])/i.test(scope),
      );
    })
      ? 'high'
      : 'medium';
  }

  const oldAdvanced = asRecord(before);
  const newAdvanced = asRecord(after);
  if (!equal(oldAdvanced.secrets, newAdvanced.secrets)) return 'high';
  if (expanded(oldAdvanced.connectors, newAdvanced.connectors)) return 'high';
  if (expanded(oldAdvanced.kortix_cli, newAdvanced.kortix_cli)) return 'high';
  const oldBehavior = asRecord(oldAdvanced.opencode);
  const newBehavior = asRecord(newAdvanced.opencode);
  if (!equal(oldBehavior.permission, newBehavior.permission)) return 'high';
  return 'medium';
}

export function classifyAgentProfileChanges(
  published: AgentProfileSections,
  draft: AgentProfileSections,
): AgentProfileClassification {
  const dataAccess = new Set<string>();
  const actions = new Set<string>();
  const schedules = new Set<string>();
  const costSettings = new Set<string>();
  const changes: ClassifiedAgentProfileChange[] = [];
  let highestRisk: AgentProfileRisk = 'low';

  for (const section of AGENT_PROFILE_SECTIONS) {
    const before = published[section];
    const after = draft[section];
    if (equal(before, after)) continue;

    const risk = sectionRisk(section, before, after);
    if (RISK_RANK[risk] > RISK_RANK[highestRisk]) highestRisk = risk;
    const kind = before === undefined ? 'add' : after === undefined ? 'remove' : 'update';
    changes.push({
      section,
      risk,
      kind,
      summary: `${kind === 'add' ? 'Add' : kind === 'remove' ? 'Remove' : 'Update'} ${section}`,
    });

    if (section === 'knowledge') {
      const prior = new Set(stringList(before));
      const next = new Set(stringList(after));
      for (const source of prior) if (!next.has(source)) add(dataAccess, source);
      for (const source of next) if (!prior.has(source)) add(dataAccess, source);
    }

    if (section === 'instructions') {
      const oldInstructions = asRecord(before);
      const newInstructions = asRecord(after);
      for (const setting of ['model', 'temperature', 'top_p', 'steps']) {
        if (!equal(oldInstructions[setting], newInstructions[setting])) costSettings.add(setting);
      }
    }

    if (section === 'integrations') {
      for (const integration of changedRecords(before, after)) {
        add(dataAccess, integration.display_name ?? integration.slug ?? integration.profile_id);
        if (sectionRisk(section, undefined, [integration]) === 'high') {
          add(actions, integration.display_name ?? integration.slug ?? integration.profile_id);
        }
      }
    }

    if (section === 'automations') {
      for (const automation of changedRecords(before, after)) {
        add(schedules, automation.name ?? automation.slug);
      }
    }

    if (section === 'advanced') {
      const oldAdvanced = asRecord(before);
      const newAdvanced = asRecord(after);
      if (!equal(oldAdvanced.secrets, newAdvanced.secrets)) {
        dataAccess.add('Secret access expanded');
      }
      if (expanded(oldAdvanced.connectors, newAdvanced.connectors)) {
        dataAccess.add('Integration access expanded');
      }
      if (expanded(oldAdvanced.kortix_cli, newAdvanced.kortix_cli)) {
        actions.add('Kortix actions expanded');
      }
      const oldBehavior = asRecord(oldAdvanced.opencode);
      const newBehavior = asRecord(newAdvanced.opencode);
      if (!equal(oldBehavior.permission, newBehavior.permission)) {
        actions.add('Permissions changed');
      }
      for (const setting of ['model', 'temperature', 'top_p', 'steps']) {
        if (!equal(oldBehavior[setting], newBehavior[setting])) costSettings.add(setting);
      }
    }
  }

  return {
    changedSections: changes.map((change) => change.section),
    changes,
    highestRisk,
    impact: {
      data_access: [...dataAccess].sort(),
      actions: [...actions].sort(),
      schedule_changes: [...schedules].sort(),
      cost_sensitive_settings: [...costSettings].sort(),
    },
  };
}
