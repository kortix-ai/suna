import { describe, expect, test } from 'bun:test';
import { within } from '../../../../shared/src/tool-output/testing';
import { extractSessionReport, type SessionReport } from './session-report';

// The regex this parser replaced was cubic in the message. It stays here ONLY as a parity oracle.
function legacyReport(text: string): SessionReport | null {
  if (!text) return null;
  const match = text.match(
    /<kortix_system[^>]*type="session-report"[^>]*>[\s\S]*?<session-report>([\s\S]*?)<\/session-report>[\s\S]*?<\/kortix_system>/i,
  );
  if (!match) return null;
  const xml = match[1]!;
  const get = (tag: string) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() || '';
  return {
    sessionId: get('session-id'),
    status: get('status') === 'FAILED' ? 'FAILED' : 'COMPLETE',
    project: get('project'),
    prompt: get('prompt'),
    result: get('result'),
  };
}

/** Deterministic PRNG (mulberry32), so a failing case reproduces. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function samples(tokens: readonly string[], count = 3000): string[] {
  const next = random(31);
  return Array.from({ length: count }, () => {
    let text = '';
    const length = Math.floor(next() * 25);
    for (let i = 0; i < length; i++) text += tokens[Math.floor(next() * tokens.length)];
    return text;
  });
}

describe('extractSessionReport', () => {
  test('returns exactly what the regex returned on 3000 random strings', () => {
    let found = 0;
    for (const text of samples(['<kortix_system', '<KORTIX_SYSTEM', ' type="session-report"', ' TYPE="Session-Report"',
      'type="session-report"', ' type="x"', '>', '<session-report>', '</session-report>', '<SESSION-REPORT>',
      '</kortix_system>', '</KORTIX_SYSTEM>', '<status>FAILED</status>', '<session-id>s</session-id>', '<status>', 'x', ' ',
      '<kortix_system type="session-report">', '<session-report><status>FAILED</status></session-report>', '</kortix_system>'])) {
      const expected = legacyReport(text);
      expect(extractSessionReport(text)).toEqual(expected);
      if (expected) found++;
    }
    expect(found).toBeGreaterThan(200);
  });

  test('reads a real report', () => {
    const text =
      '<kortix_system type="session-report" source="kortix-orchestrator">\n<session-report>\n<session-id>ses_1</session-id>\n<status>FAILED</status>\n<project>p</project>\n<prompt>do it</prompt>\n<result>no</result>\n</session-report>\n</kortix_system>';
    expect(extractSessionReport(text)).toEqual({ sessionId: 'ses_1', status: 'FAILED', project: 'p', prompt: 'do it', result: 'no' });
  });
});

describe('no message can freeze the host that parses it', () => {
  // Cubic: 7.6 s at 60k characters.
  within('report: 1,130 openers that never close (60k chars)', () =>
    extractSessionReport('<kortix_system type="session-report"><session-report>'.repeat(1_130)));
  // Quadratic inside the report: each field search re-scanned the report.
  within('report: 30k field openers that never close', () =>
    extractSessionReport(`<kortix_system type="session-report"><session-report>${'<status>'.repeat(30_000)}</session-report></kortix_system>`));
  within('report: 240k characters of openers', () =>
    extractSessionReport('<kortix_system type="session-report"><session-report>'.repeat(4_500)));
});
