import { describe, expect, test } from 'bun:test';

import { classifyTurnError } from '../channels/slack/errors';
import { mrkdwnToTeamsMarkdown as toTeams } from '../channels/teams/markdown';

// `classifyTurnError` is shared with Slack and writes Slack's dialect. Seen on
// dev 2026-09-21: a provider-auth failure reached a Teams card reading
// literally ":warning: The model provider rejected this request", with the
// sentence in ITALIC — `*text*` is bold in mrkdwn and italic in Markdown. The
// copy was right; the dialect was not.

describe('mrkdwnToTeamsMarkdown', () => {
  test('the exact card from the incident renders as emoji + bold', () => {
    const classified = classifyTurnError({
      name: 'ProviderAuthError',
      message: 'invalid_token',
      providerID: 'anthropic',
    });
    const out = toTeams(classified.text);

    expect(out).toStartWith('⚠️ **The anthropic provider rejected this request**');
    expect(out).not.toContain(':warning:');
  });

  test('every shortcode the classifier can emit has a mapping', () => {
    // A branch that grows a new shortcode must grow the map with it, or the
    // shortcode is silently dropped and the card loses its glyph.
    const cases: Array<Parameters<typeof classifyTurnError>[0]> = [
      { name: 'APIError', statusCode: 402, message: 'insufficient credits' },
      { name: 'APIError', statusCode: 429, message: 'rate limit' },
      { name: 'MessageOutputLengthError' },
      { name: 'APIError', statusCode: 400, message: 'context window exceeded' },
      { name: 'ProviderAuthError', message: 'invalid key' },
      { name: 'APIError', statusCode: 503, message: 'upstream' },
      { name: 'UnknownError', message: 'something else entirely' },
    ];
    for (const info of cases) {
      const out = toTeams(classifyTurnError(info).text);
      expect(out, JSON.stringify(info)).not.toMatch(/:[a-z0-9_+-]+:/i);
    }
  });

  test('an unmapped shortcode is dropped, never shown raw', () => {
    // A bare `:sparkles:` in a failure card is noise at best.
    expect(toTeams(':sparkles: something happened')).toBe('something happened');
  });

  test('Slack bold becomes Markdown bold, not italic', () => {
    expect(toTeams('*Usage limit reached* — wait a minute')).toBe(
      '**Usage limit reached** — wait a minute',
    );
  });

  test('already-Markdown bold is left alone', () => {
    expect(toTeams('**already bold** and *slack bold*')).toBe('**already bold** and **slack bold**');
  });

  test('Slack italic becomes Markdown italic', () => {
    expect(toTeams('_Run stopped._')).toBe('*Run stopped.*');
  });

  test('snake_case identifiers survive the italic rule', () => {
    // This copy names real fields; `session_id` must not become `session*id*`.
    expect(toTeams('check session_id and MS_TEAMS_TENANT_ID')).toBe(
      'check session_id and MS_TEAMS_TENANT_ID',
    );
  });

  test('nothing inside code is rewritten', () => {
    expect(toTeams('run `kortix channels status --platform teams` now')).toBe(
      'run `kortix channels status --platform teams` now',
    );
    expect(toTeams('```\n*not bold* :warning:\n```')).toBe('```\n*not bold* :warning:\n```');
  });

  test('a balance stays bold and keeps its currency', () => {
    const out = toTeams(classifyTurnError({ name: 'APIError', statusCode: 402, message: 'insufficient credits: $1.23 remaining' }).text);
    expect(out).toContain('💳');
    expect(out).not.toContain(':credit_card:');
  });

  test('empty input is returned untouched', () => {
    expect(toTeams('')).toBe('');
  });

  test('Slack output is NOT translated — the two dialects stay apart', () => {
    // The whole point of converting at the Teams boundary is that Slack's copy
    // is unchanged. If this ever fails, the shared classifier was edited.
    const slack = classifyTurnError({ name: 'ProviderAuthError', message: 'invalid' }).text;
    expect(slack).toContain(':warning:');
    expect(slack).toMatch(/\*[^*]/);
  });
});
