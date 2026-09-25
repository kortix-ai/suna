/**
 * Create-time title source for the channels that have no behavioural
 * create-body test yet: trigger, Telegram, email. Whatever started the session,
 * the title source is the user's own words, never the envelope a channel
 * renders around them (channel sessions are `visibility: 'project'`, so their
 * title is team-visible).
 *
 * Each row pins the semantics (`titleSourceForCreate` over the body shape that
 * origin builds) and the wiring (the literal field in that origin's create
 * body, read from the source). Slack and Teams prove the wiring behaviourally
 * in `unit-slack-dispatch-session.test.ts` and `unit-teams-session.test.ts`;
 * the stored, capped source is proven in `e2e-project-session-contract.test.ts`.
 * A row here retires when its channel's own suite asserts the create body.
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
      opencode_model: 'kortix/glm-5.3-flash',
    };
    expect(titleSourceForCreate(body)).toBe(
      'Triage the new Sentry issue and open a change request',
    );

    const source = createBody('projects/lib/triggers.ts', 'enforceAccountCap: false');
    expect(source).toContain('initial_prompt: renderedPrompt');
    expect(source).not.toContain('title_source');
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
      connector_bindings: { email: { connection_id: 'prof-1' } },
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
});
