import { describe, expect, test } from 'bun:test';
import {
  buildAnswerCard,
  buildChoiceCard,
  buildConnectAccountCard,
  buildFinalCard,
  buildPlanCard,
  buildQuestionCard,
  buildRequestAccessCard,
  buildReviewCard,
} from '../channels/teams/cards';
import type { StreamTaskChunk } from '../channels/slack-api';

function step(over: Partial<StreamTaskChunk>): StreamTaskChunk {
  return { type: 'task_update', id: 'step-0', title: 'Reading logs', status: 'in_progress', ...over };
}

function texts(card: Record<string, unknown>): string[] {
  return (card.body as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'TextBlock')
    .map((b) => b.text ?? '');
}

function actions(card: Record<string, unknown>): Array<{ type: string; verb?: string; url?: string; data?: Record<string, unknown> }> {
  return (card.actions as Array<{ type: string; verb?: string; url?: string; data?: Record<string, unknown> }>) ?? [];
}

describe('buildPlanCard', () => {
  test('is a versioned AdaptiveCard with a title + a line per step', () => {
    const card = buildPlanCard('Working on it…', [
      step({ id: 'step-0', title: 'Reading logs', status: 'complete' }),
      step({ id: 'step-1', title: 'Drafting summary', status: 'in_progress' }),
    ]);
    expect(card.type).toBe('AdaptiveCard');
    expect(card.version).toBe('1.5');
    const lines = texts(card);
    expect(lines[0]).toBe('Working on it…');
    expect(lines.some((t) => t.includes('✓') && t.includes('Reading logs'))).toBe(true);
    expect(lines.some((t) => t.includes('⏳') && t.includes('Drafting summary'))).toBe(true);
  });

  test('renders detail + output subtitles when present', () => {
    const card = buildPlanCard('t', [step({ details: 'from Datadog', output: 'found 3' })]);
    const lines = texts(card);
    expect(lines).toContain('from Datadog');
    expect(lines).toContain('found 3');
  });
});

describe('buildFinalCard', () => {
  test('marks an error step with ✗ and appends the body + session link', () => {
    const card = buildFinalCard({
      title: 'Run failed',
      steps: [step({ status: 'error', title: 'Build' })],
      body: 'It broke.',
      sessionUrl: 'https://app/session',
    });
    const lines = texts(card);
    expect(lines[0]).toBe('Run failed');
    expect(lines.some((t) => t.includes('✗') && t.includes('Build'))).toBe(true);
    expect(lines).toContain('It broke.');
    expect(lines.some((t) => t.includes('https://app/session'))).toBe(true);
  });
});

describe('buildAnswerCard', () => {
  test('is a single-body card, with the link only when provided', () => {
    expect(texts(buildAnswerCard('hello'))).toEqual(['hello']);
    expect(texts(buildAnswerCard('hello', 'https://app/s')).some((t) => t.includes('https://app/s'))).toBe(true);
  });
});

describe('interactive cards', () => {
  test('connect-account card carries an OpenUrl login action', () => {
    const a = actions(buildConnectAccountCard('https://app/teams/login/tok'));
    expect(a[0]?.type).toBe('Action.OpenUrl');
    expect(a[0]?.url).toBe('https://app/teams/login/tok');
  });

  test('request-access card carries an Execute action with the projectId', () => {
    const a = actions(buildRequestAccessCard('proj-1'));
    expect(a[0]?.type).toBe('Action.Execute');
    expect(a[0]?.verb).toBe('teams_request_access');
    expect(a[0]?.data?.projectId).toBe('proj-1');
  });

  test('choice card renders one Execute action per choice (capped at 6)', () => {
    const card = buildChoiceCard({
      title: 'Pick',
      verb: 'teams_set_model',
      choices: Array.from({ length: 8 }, (_, i) => ({ title: `m${i}`, data: { model: `m${i}` } })),
    });
    const a = actions(card);
    expect(a).toHaveLength(6);
    expect(a.every((x) => x.type === 'Action.Execute' && x.verb === 'teams_set_model')).toBe(true);
  });

  test('question card turns option labels into answer actions', () => {
    const card = buildQuestionCard([{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }]);
    const a = actions(card);
    expect(a.map((x) => x.data?.answer)).toEqual(['Yes', 'No']);
    expect(a.every((x) => x.verb === 'teams_answer')).toBe(true);
  });

  test('review card carries approve/changes/deny execute actions + a view link', () => {
    const card = buildReviewCard({ reviewItemId: 'r1', title: 'Deploy', summary: 'ship', risk: 'high', viewUrl: 'https://app/r' });
    const a = actions(card);
    const verdicts = a.filter((x) => x.type === 'Action.Execute').map((x) => x.data?.verdict);
    expect(verdicts).toEqual(['approve', 'changes', 'reject']);
    expect(a.some((x) => x.type === 'Action.OpenUrl' && x.url === 'https://app/r')).toBe(true);
  });
});
