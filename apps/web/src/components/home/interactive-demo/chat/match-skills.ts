import { CORE_SKILLS, GKW_SKILLS } from '../data';

const ALL_SKILLS = [...CORE_SKILLS, ...GKW_SKILLS];

const PROMPT_RULES: { test: RegExp; skills: string[] }[] = [
  {
    test: /\b(slack|#\w+|thread|reply)\b/i,
    skills: ['kortix-slack', 'response-drafting'],
  },
  {
    test: /\b(board\s*deck|q3|financials?|metrics\.q3)\b/i,
    skills: ['sql-queries', 'financial-statements', 'visualization', 'pptx'],
  },
  {
    test: /\b(pipeline|crm|deal|hubspot)\b/i,
    skills: ['customer-research', 'daily-briefing', 'stakeholder-comms'],
  },
  {
    test: /\b(repo|commit|git|monday|changed)\b/i,
    skills: ['coding-and-data', 'validation'],
  },
  {
    test: /\b(finance|weekly\s*report|email.*team)\b/i,
    skills: ['sql-queries', 'financial-statements', 'xlsx', 'stakeholder-comms'],
  },
  {
    test: /\b(summarize|summary|briefing|updates?)\b/i,
    skills: ['daily-briefing', 'stakeholder-comms'],
  },
  {
    test: /\b(deck|pptx|presentation|slides?)\b/i,
    skills: ['pptx', 'presentations', 'create-an-asset'],
  },
  {
    test: /\b(sql|warehouse|query|dataset)\b/i,
    skills: ['sql-queries', 'exploration'],
  },
  {
    test: /\b(research|investigate|look\s*into)\b/i,
    skills: ['research-assistant', 'deep-research'],
  },
  {
    test: /\b(legal|contract|nda)\b/i,
    skills: ['contract-review', 'legal-writer'],
  },
  {
    test: /\b(support|ticket|triage)\b/i,
    skills: ['ticket-triage', 'knowledge-management'],
  },
];

const SKILL_NAMES = new Set(ALL_SKILLS.map(([n]) => n));

function scoreByOverlap(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length > 2);

  const scored = ALL_SKILLS.map(([name, desc]) => {
    const hay = `${name} ${desc}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) score += t.length > 4 ? 3 : 1;
    }
    return { name, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map((s) => s.name);
}

/** Pick up to 4 real catalog skills that fit the user prompt. */
export function matchSkillsFromPrompt(text: string, explicit?: string[]): string[] {
  if (explicit?.length) {
    return explicit.filter((s) => SKILL_NAMES.has(s)).slice(0, 4);
  }

  const trimmed = text.trim();
  for (const { test, skills } of PROMPT_RULES) {
    if (test.test(trimmed)) {
      return skills.filter((s) => SKILL_NAMES.has(s)).slice(0, 4);
    }
  }

  const scored = scoreByOverlap(trimmed);
  if (scored.length > 0) return scored;

  return ['kortix-executor'];
}

export function skillDescription(name: string): string | undefined {
  return ALL_SKILLS.find(([n]) => n === name)?.[1];
}
