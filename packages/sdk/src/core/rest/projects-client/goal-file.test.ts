import { describe, expect, test } from 'bun:test';
import { formatGoalFile, parseGoalFile } from './goal-file';
import type { ProjectGoalDocument } from './goals';

const DOC: ProjectGoalDocument = {
  version: 1,
  objective: 'EU billing live: invoices in EUR with VAT',
  status: 'active',
  summary: 'Pricing page done; invoice template next.',
  assigned_user: '00000000-0000-4000-8000-000000000001',
  agent: 'billing',
  space: null,
  success_criteria: [
    { id: 'c1', text: 'An EUR invoice renders VAT: 19% for a DE customer', met: true, evidence: 'evidence/invoice.pdf' },
    { id: 'c2', text: 'Checkout charges "EUR" (not USD)', met: false, evidence: null },
  ],
  items: [],
  links: ['evidence/invoice.pdf', 'https://example.test/cr/12'],
  waiting_on: null,
  heartbeat_every: '4h',
  max_wakes_per_day: 12,
  max_sessions: 10,
  wake_day: '2026-10-28',
  wake_count: 3,
  last_wake_at: '2026-10-28T09:00:00Z',
  sessions: [{ id: 's-owner', role: 'owner', since: '2026-10-28T08:00:00Z' }],
  reminder_id: 'reminder.0123456789ab',
  next_wake_at: '2026-10-28T13:00:00Z',
  verified_by: null,
  transitions: [
    { from: null, to: 'draft', at: '2026-10-28T08:00:00Z', reason: 'goal created', by: 's-owner' },
    { from: 'draft', to: 'active', at: '2026-10-28T08:05:00Z', reason: "criteria written: it's ready", by: 's-owner' },
  ],
  format: 'goal.md',
  body: '# EU billing\n\n## Context\n\nFrom the Q4 plan.\n',
};

describe('GOAL.md', () => {
  test('format then parse returns the same document and body', () => {
    const text = formatGoalFile(DOC);
    expect(text.startsWith('---\ngoal: ')).toBe(true);
    expect(text).toContain('\nstate: active\n');
    expect(text).toContain('\nassigned_agent: billing\n');
    expect(text).toContain('\ndone_criteria:\n  - id: c1\n');
    expect(text.endsWith(DOC.body!)).toBe(true);
    expect(parseGoalFile(text)).toEqual(DOC);
  });

  test('reads a hand-written file: plain, quoted and commented values, empty lists', () => {
    const text = [
      '---',
      '# written in Drive',
      'goal: Ship the docs site',
      "state: 'draft'",
      'assigned_user: ~',
      'assigned_agent: writer  # the docs agent',
      'done_criteria:',
      '- id: c1',
      '  text: "The site answers 200: on /docs"',
      '  met: false',
      '  evidence:',
      'links: []',
      'max_wakes_per_day: 6',
      '---',
      'Body text.',
    ].join('\n');
    expect(parseGoalFile(text)).toMatchObject({
      objective: 'Ship the docs site',
      status: 'draft',
      assigned_user: null,
      agent: 'writer',
      success_criteria: [{ id: 'c1', text: 'The site answers 200: on /docs', met: false, evidence: null }],
      links: [],
      max_wakes_per_day: 6,
      sessions: [],
      transitions: [],
      items: [],
      format: 'goal.md',
      body: 'Body text.',
    });
  });

  test('a file without front matter or without a goal is not a goal', () => {
    expect(parseGoalFile('# Just notes')).toBeNull();
    expect(parseGoalFile('---\nstate: active\n---\n')).toBeNull();
    expect(parseGoalFile('---\ngoal: unterminated\n')).toBeNull();
  });

  test('a value that looks like a number, a boolean or null keeps its string type', () => {
    const doc = { ...DOC, objective: '10', summary: 'true', body: '' };
    expect(parseGoalFile(formatGoalFile(doc))).toMatchObject({ objective: '10', summary: 'true' });
  });
});
