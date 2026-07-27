/**
 * The delivery tiers of R-12g, driven through the explicit Slack seam.
 *
 * The integration test proves the DEGRADE path against a real database (this box
 * has no Slack install, so every real call falls through to `inbox`). What it
 * cannot prove is the branch that actually fires in production — a Slack DM to a
 * named responder — because there is no Slack workspace to post into. That
 * branch is proven here, against the exact five calls the module makes.
 *
 * This is a unit test and it says what it is: it proves `deliverRequest` drives
 * the Slack primitives correctly and reports `slack`. It does NOT prove Slack
 * accepts the message; only a real workspace can do that.
 *
 * No `mock.module` anywhere: the transport arrives as a parameter, so this file
 * neither imports nor replaces `channels/*` and cannot be affected by — or
 * affect — whatever else shares its bun process.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { deliverRequest, type SlackTransport } from './delivery';
import type { AgiRequestRow } from './wire';

interface SlackCall {
  fn: string;
  args: unknown[];
}

let calls: SlackCall[] = [];
let token: string | null;
let install: { workspaceId: string } | null;
let slackUserId: string | null;
let dmChannel: string | null;
let postResult: string | null;
let postThrows: boolean;

const slack: SlackTransport = {
  loadToken: async (projectId) => {
    calls.push({ fn: 'loadToken', args: [projectId] });
    return token;
  },
  loadInstall: async (projectId) => {
    calls.push({ fn: 'loadInstall', args: [projectId] });
    return install;
  },
  lookupUserId: async (teamId, userId) => {
    calls.push({ fn: 'lookupUserId', args: [teamId, userId] });
    return slackUserId;
  },
  openDm: async (t, userId) => {
    calls.push({ fn: 'openDm', args: [t, userId] });
    return dmChannel;
  },
  post: async (t, channel, text, blocks) => {
    calls.push({ fn: 'post', args: [t, channel, text, blocks] });
    if (postThrows) throw new Error('slack exploded');
    return postResult;
  },
};

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const RESPONDER = '33333333-3333-4333-8333-333333333333';

function request(overrides: Partial<AgiRequestRow> = {}): AgiRequestRow {
  return {
    requestId: '44444444-4444-4444-8444-444444444444',
    workspaceId: WORKSPACE,
    taskId: TASK,
    kind: 'secret',
    need: 'GOOGLE_SEARCH_CONSOLE_TOKEN',
    why: 'The daily push cannot read rankings without it.',
    url: 'https://app.kortix.test/setup/abc',
    responderUserId: RESPONDER,
    status: 'pending',
    deliveredAt: null,
    deliveredVia: null,
    requestedBySessionId: 'ses_push',
    originFingerprint: 'agi-request:v1:abc',
    satisfiedAt: null,
    satisfiedByUserId: null,
    createdAt: new Date('2026-07-27T07:00:00.000Z'),
    updatedAt: new Date('2026-07-27T07:00:00.000Z'),
    ...overrides,
  } as AgiRequestRow;
}

function deliver(overrides: Partial<AgiRequestRow> = {}) {
  return deliverRequest({
    workspaceId: WORKSPACE,
    request: request(overrides),
    taskTitle: 'Measure the core terms',
    slack,
  });
}

function called(fn: string): SlackCall | undefined {
  return calls.find((call) => call.fn === fn);
}

beforeEach(() => {
  calls = [];
  token = 'xoxb-test';
  install = { workspaceId: 'T123' };
  slackUserId = 'U456';
  dmChannel = 'D789';
  postResult = '1700000000.000100';
  postThrows = false;
});

describe('deliverRequest — tier 1: a Slack DM to the responder', () => {
  test('a linked responder gets a direct message, and delivery reports `slack`', async () => {
    const result = await deliver();
    expect(result).toEqual({ via: 'slack', slackSkipped: null });

    // The same sequence `notifyAdminsOfAccessRequest` performs, and the complete
    // list of what this module touches — which is what makes the seam honest.
    expect(calls.map((call) => call.fn)).toEqual([
      'loadToken',
      'loadInstall',
      'lookupUserId',
      'openDm',
      'post',
    ]);
    // The identity is looked up in THIS Slack team, not globally.
    expect(called('lookupUserId')?.args).toEqual(['T123', RESPONDER]);
    expect(called('openDm')?.args).toEqual(['xoxb-test', 'U456']);
  });

  test('the message says what is needed, why, and where to supply it', async () => {
    await deliver();
    const [, channel, fallback, blocks] = called('post')!.args as [string, string, string, any[]];
    expect(channel).toBe('D789');
    // The fallback is what a phone notification shows.
    expect(fallback).toContain('GOOGLE_SEARCH_CONSOLE_TOKEN');

    const text = blocks[0].text.text as string;
    expect(text).toContain('cannot read rankings');
    expect(text).toContain('Measure the core terms');
    expect(text).toContain('ses_push');
    expect(text).toContain('https://app.kortix.test/setup/abc');
    // The human is told not to reply with the key. The minted form is the only
    // channel a credential may travel on.
    expect(text).toContain('never paste it in a reply');
  });

  test('the buttons are LINKS — this is a delivery, not a second approval subsystem', async () => {
    await deliver();
    const blocks = called('post')!.args[3] as any[];
    const actions = blocks.find((block) => block.type === 'actions');
    // Every button carries a url. An `action_id`-only button would need an
    // interactivity handler and a way to resume a session that is long gone.
    for (const element of actions.elements) expect(typeof element.url).toBe('string');
    expect(actions.elements[0].url).toBe('https://app.kortix.test/setup/abc');
  });

  test('an ask with no link still posts, without the supply-it button', async () => {
    await deliver({ url: null, kind: 'decision', need: 'Pick an execution venue' });
    const blocks = called('post')!.args[3] as any[];
    const actions = blocks.find((block) => block.type === 'actions');
    expect(actions.elements.every((e: any) => e.action_id !== 'agi_request_supply')).toBe(true);
  });

  test('the DM tells the human how to close it, so the ask is not a dead end', async () => {
    await deliver();
    const blocks = called('post')!.args[3] as any[];
    const context = blocks.find((block) => block.type === 'context');
    expect(context.elements[0].text).toContain('kortix tasks answer');
    expect(context.elements[0].text).toContain('44444444-4444-4444-8444-444444444444');
  });
});

describe('deliverRequest — tier 2: the durable inbox', () => {
  test('no Slack install degrades to `inbox`, never to nothing', async () => {
    token = null;
    expect(await deliver()).toEqual({ via: 'inbox', slackSkipped: 'no_install' });
  });

  test('a token with no team id is also no install', async () => {
    install = null;
    expect(await deliver()).toEqual({ via: 'inbox', slackSkipped: 'no_install' });
  });

  test('a responder who never linked their Slack account degrades to `inbox`', async () => {
    // Exactly the fallback notifyAdminsOfAccessRequest relies on: an unlinked
    // admin still sees it in Kortix.
    slackUserId = null;
    expect(await deliver()).toEqual({ via: 'inbox', slackSkipped: 'no_identity' });
    expect(called('post')).toBeUndefined();
  });

  test('a rejected post degrades to `inbox` — a Slack failure may not cost us the ask', async () => {
    postResult = null;
    expect(await deliver()).toEqual({ via: 'inbox', slackSkipped: 'post_failed' });
  });

  test('a Slack outage that THROWS degrades too, and never propagates', async () => {
    postThrows = true;
    expect(await deliver()).toEqual({ via: 'inbox', slackSkipped: 'post_failed' });
  });

  test('a DM channel that will not open degrades to `inbox`', async () => {
    dmChannel = null;
    expect(await deliver()).toEqual({ via: 'inbox', slackSkipped: 'post_failed' });
  });
});

describe('deliverRequest — no addressee', () => {
  test('an ask with no responder reaches nothing, and does not call Slack at all', async () => {
    // R-28 answer 5 wants a SPECIFIC responder. With none there is nobody to
    // deliver to, and liveness reports the task as stalled rather than waiting.
    expect(await deliver({ responderUserId: null })).toEqual({ via: null, slackSkipped: null });
    expect(calls).toEqual([]);
  });
});
