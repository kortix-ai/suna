import { describe, expect, test } from 'bun:test';
import { buildAnswerCard, buildFinalCard, buildPlanCard } from '../channels/teams/cards';
import type { StreamTaskChunk } from '../channels/slack-api';

function step(over: Partial<StreamTaskChunk>): StreamTaskChunk {
  return { type: 'task_update', id: 'step-0', title: 'Reading logs', status: 'in_progress', ...over };
}

function texts(card: Record<string, unknown>): string[] {
  return (card.body as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'TextBlock')
    .map((b) => b.text ?? '');
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
