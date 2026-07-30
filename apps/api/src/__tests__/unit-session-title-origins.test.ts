/**
 * One case per session ORIGIN: whatever started the session, the create-time
 * title source is the user's own words — never the scaffolded envelope a channel
 * renders around them, and never a leaked workspace/channel/chat identifier
 * (channel sessions are `visibility: 'project'`, so their title is team-visible).
 *
 * Each origin is pinned twice:
 *   1. semantics — `titleSourceForCreate` over the body shape that origin builds;
 *   2. wiring — the literal field in that origin's create body, read out of the
 *      source, so renaming/dropping it fails here instead of silently reverting
 *      a channel to titling from its rendered envelope.
 * The renderers themselves stay private; asserting on the source keeps this
 * honest without a process-global `mock.module`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { titleSourceForCreate } from '../projects/session-title-generate';

const SRC = join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** The `body: { … }` literal a create call site builds, as source text. */
function createBody(rel: string, marker: string): string {
  const src = read(rel);
  const at = src.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = src.indexOf('body: {', at);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf('{', open); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated create body in ${rel}`);
}

describe('session-title origins — create-time title source', () => {
  test('trigger (fresh fire): the rendered trigger template IS the title', () => {
    // A trigger's prompt is its own per-fire template — the most specific title
    // available — so it deliberately passes no title_source.
    const body = {
      agent_name: 'default',
      initial_prompt: 'Triage the new Sentry issue and open a change request',
      opencode_model: 'kortix/glm-5.2',
    };
    expect(titleSourceForCreate(body)).toBe(
      'Triage the new Sentry issue and open a change request',
    );

    const source = createBody('projects/lib/triggers.ts', 'enforceAccountCap: false');
    expect(source).toContain('initial_prompt: renderedPrompt');
    expect(source).not.toContain('title_source');
  });

  test('slack: the user message, not the rendered envelope', () => {
    const body = {
      agent_name: 'default',
      initial_prompt: [
        "You're answering a message on Slack as a teammate.",
        'Workspace:  T0123',
        'Channel:    C0456',
        'Thread ts:  1700000000.0001',
        'Message:',
        'can you bump the node version in CI',
      ].join('\n'),
      title_source: 'can you bump the node version in CI',
    };
    const title = titleSourceForCreate(body);
    expect(title).toBe('can you bump the node version in CI');
    expect(title).not.toContain('Workspace:');
    expect(title).not.toContain('Thread ts:');
    expect(title).not.toContain('T0123');

    const source = createBody('channels/slack/session.ts', 'slackSessionLifecycle.createSession(');
    expect(source).toContain('title_source: event.text ?? null');
  });

  test('teams: the activity text, not the rendered envelope', () => {
    const body = {
      initial_prompt: [
        "You're answering a message on Microsoft Teams as a teammate.",
        'Tenant:        tenant-1',
        'Conversation:  conv-1',
        'Message:',
        'summarize yesterday standup',
      ].join('\n'),
      title_source: 'summarize yesterday standup',
    };
    const title = titleSourceForCreate(body);
    expect(title).toBe('summarize yesterday standup');
    expect(title).not.toContain('Tenant:');
    expect(title).not.toContain('Conversation:');

    const source = createBody('channels/teams/session.ts', 'teamsSessionLifecycle.createSession(');
    expect(source).toContain('title_source: activity.text ?? null');
  });

  test('telegram: message text, falling back to a photo caption', () => {
    const text = {
      initial_prompt: 'You received a message on Telegram.\nChat:        99 (private)\n…',
      title_source: 'what changed in the deploy',
    };
    const title = titleSourceForCreate(text);
    expect(title).toBe('what changed in the deploy');
    expect(title).not.toContain('Chat:');
    expect(title).not.toContain('telegram send --chat');

    // photo update: no `text`, only `caption`
    expect(
      titleSourceForCreate({ initial_prompt: 'envelope…', title_source: 'the CI graph' }),
    ).toBe('the CI graph');

    const source = createBody(
      'channels/telegram-webhook.ts',
      'const result = await createSession({',
    );
    expect(source).toContain('title_source: message.text ?? message.caption ?? null');
  });

  test('email: titles from the SUBJECT at create — it has no initial_prompt at all', () => {
    const body = {
      agent_name: 'default',
      connector_bindings: { email: { profile_id: 'prof-1' } },
      title_source: 'Invoice discrepancy for March',
    };
    expect(body).not.toHaveProperty('initial_prompt');
    expect(titleSourceForCreate(body)).toBe('Invoice discrepancy for March');

    const source = createBody('channels/email/session.ts', 'emailSessionLifecycle.createSession(');
    expect(source).not.toContain('initial_prompt');
    expect(source).toContain('title_source: messageSubject(event) ?? messageSummary(event)');
    // The full rendered envelope still reaches the agent via postCreate.
    expect(read('channels/email/session.ts')).toContain("type: 'deliver_prompt'");
  });

  test('the clean source is PERSISTED, so a fallback hook cannot re-title from the envelope', () => {
    // Hook 1 is not guaranteed: its gateway call can 429. Seconds later the
    // queued initial prompt drains through continueSession, whose only text
    // IS the rendered envelope — and `needsTitle` is still true. Storing the
    // clean source at create is what keeps that retry honest.
    const create = read('projects/lib/sessions.ts');
    expect(create).toContain('const explicitTitleSource = normalizeString(body.title_source');
    expect(create).toContain('title_source: explicitTitleSource.slice(0, TITLE_SOURCE_MAX_CHARS)');
    expect(read('projects/session-title-generate.ts')).toContain(
      'storedTitleSource(row) ?? suppliedText',
    );
  });

  test('ui (web new-session): no create-time prompt → the proxy hook owns the title', () => {
    // apps/web never sets initial_prompt; it stashes the prompt client-side and
    // sends it over the OpenCode REST proxy once the session exists.
    expect(titleSourceForCreate({ base_ref: 'main', agent_name: 'default' })).toBeNull();
  });

  test('sdk/api (POST /sessions with a prompt): that prompt is the title', () => {
    expect(
      titleSourceForCreate({ base_ref: 'main', initial_prompt: 'migrate the auth module' }),
    ).toBe('migrate the auth module');
  });

  test('pre-named platform sessions keep their fixed labels', () => {
    // body.name is the documented "I already know the title" escape hatch:
    // sessions.ts writes it to metadata.name, so needsTitle() is false and
    // generation never overwrites it.
    for (const [rel, marker, name] of [
      ['projects/routes/r2.ts', "source: 'system:sandbox-build-fix'", "name: 'Fix sandbox build'"],
      ['projects/routes/r10.ts', 'const result = await createSession({', 'name: `Add ${'],
    ] as const) {
      const source = createBody(rel, marker);
      expect(source).toContain(name);
      expect(source).not.toContain('title_source');
    }
  });
});
