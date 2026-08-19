import { afterAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// @Kortix from another bot did nothing, and the code that was supposed to allow
// it had never been reachable.
//
// dispatchSlackEvent gated on:
//
//     if ((botUserId && event.user === botUserId) || event.bot_id) return;
//
// `|| event.bot_id` returns on ANY bot, so no message from another app ever
// reached classifyEvent. classifyEvent, meanwhile, has a `bot_message` branch
// written specifically to let other bots through, justified in its own comment
// by "our own bot is blocked by the separate gate in dispatchSlackEvent" — an
// assumption that gate contradicted.
//
// The three tests in unit-slack-classify-event.test.ts that assert this
// behaviour (bot_message → dm / mention / ignored-without-mention) PASS TODAY
// while the feature cannot work, because they call classifyEvent directly and
// never cross the gate. That is the blind spot this file closes: the gate is
// now a named function with its own cases, plus a source contract on the call
// site so the fix cannot be silently unwired.
//
// Loop safety is unchanged. Only OUR messages can loop, and event.user
// identifies them — every post this codebase makes uses a plain bot token, with
// no username/icon override anywhere under channels/slack, so Slack stamps our
// bot user id on the resulting event. The last test pins that absence.

// ─── Mocks so importing dispatch.ts (and its module graph) loads cleanly ──────
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([]));
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain() },
  hasDatabase: () => true,
}));
mock.module('../channels/slack/turn', () => ({
  claimFinalize: async () => true,
  openPlanMessage: async () => true,
  repaintLivePlan: async () => {},
  loadTurn: async () => null,
  startTurn: async () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
  saveTurn: async () => {},
  deleteTurn: async () => {},
  finalizeTurn: async () => {},
  buildSlackTurnEnv: () => ({}),
  relayTurnAnswer: async () => {},
  relayTurnEnd: async () => {},
  relayTurnStep: async () => {},
  rowToHandle: () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
}));
const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  loadSlackBotUserIdForProject: async () => 'B1',
  loadSlackTokenForProject: async () => 'xoxb-test',
  loadSlackSigningSecretForProject: async () => null,
  loadSlackTeamNameForProject: async () => null,
  listProjectsForWorkspace: async () => ['proj-1'],
  loadSlackInstall: async () => null,
}));
mock.module('../channels/slack-api', () => ({
  addReaction: async () => {},
  appendStream: async () => {},
  deleteMessage: async () => {},
  getChannelName: async () => 'general',
  joinChannel: async () => true,
  openDmChannel: async () => 'D1',
  postEphemeral: async () => true,
  postBlocks: async () => 'ts',
  postMessage: async () => 'ts',
  publishHomeView: async () => {},
  removeReaction: async () => {},
  startStream: async () => 'ts',
  stopStream: async () => {},
  updateBlocks: async () => {},
  updateMessage: async () => {},
}));

const { classifyEvent, isOwnBotEvent } = await import('../channels/slack/dispatch');

const BOT = 'B1';
const ev = (e: Record<string, unknown>) => ({ type: 'message', ...e }) as any;

afterAll(() => mock.restore());

describe('isOwnBotEvent — blocks ourselves, not every bot', () => {
  test('our own message (user === botUserId) is ours', () => {
    expect(isOwnBotEvent(ev({ user: BOT, bot_id: 'BSELF', text: 'hi' }), BOT)).toBe(true);
  });

  test('THE FIX: another bot with its own bot_id is NOT ours', () => {
    expect(isOwnBotEvent(ev({ user: 'U_OTHERBOT', bot_id: 'B999', text: '<@B1> go' }), BOT)).toBe(false);
  });

  test('THE FIX: a webhook / Workflow Builder post (bot_id, NO user) is NOT ours', () => {
    // Incoming webhooks and Workflow Builder post with bot_id and no user at
    // all. These were blocked outright, so an automation could never tag Kortix.
    expect(isOwnBotEvent(ev({ bot_id: 'B999', subtype: 'bot_message', text: '<@B1> deploy done' }), BOT)).toBe(false);
  });

  test('a human is never ours', () => {
    expect(isOwnBotEvent(ev({ user: 'U_HUMAN', text: '<@B1> hello' }), BOT)).toBe(false);
  });

  test('identity unknown + a bot message → treated as ours (stay conservative)', () => {
    // botUserId comes from a secret read on every event. If that read fails we
    // cannot tell our own message from another app's, and guessing wrong is an
    // infinite self-loop — so bot traffic stops until we know who we are.
    expect(isOwnBotEvent(ev({ bot_id: 'B999', text: 'anything' }), null)).toBe(true);
  });

  test('identity unknown + a HUMAN message still passes — humans are not collateral', () => {
    // A blanket fail-closed would silence the bot for people too. Only the
    // ambiguous (bot) traffic is dropped.
    expect(isOwnBotEvent(ev({ user: 'U_HUMAN', text: '<@B1> hello' }), null)).toBe(false);
  });
});

describe('the event another bot sends now classifies as real work', () => {
  // These mirror unit-slack-classify-event.test.ts, but paired with the gate —
  // there they proved a branch nothing could reach.
  test('another bot @-mentioning us in a channel → mention', async () => {
    const e = ev({ subtype: 'bot_message', channel_type: 'channel', text: '<@B1> analyze this', bot_id: 'B999' });
    expect(isOwnBotEvent(e, BOT)).toBe(false);
    expect(await classifyEvent('T1', e, BOT)).toBe('mention');
  });

  test('another bot DMing us → dm', async () => {
    const e = ev({ subtype: 'bot_message', channel_type: 'im', text: 'hello from another bot', bot_id: 'B999' });
    expect(isOwnBotEvent(e, BOT)).toBe(false);
    expect(await classifyEvent('T1', e, BOT)).toBe('dm');
  });

  test('bot chatter with no mention is STILL ignored — this is why no channel toggle is needed', async () => {
    // The mention requirement is the opt-in. Opening the gate does not make the
    // bot answer ambient traffic.
    const e = ev({ subtype: 'bot_message', channel_type: 'channel', text: 'other bot chatter', bot_id: 'B999' });
    expect(isOwnBotEvent(e, BOT)).toBe(false);
    expect(await classifyEvent('T1', e, BOT)).toBe('ignore');
  });
});

describe('source contracts', () => {
  const dispatchSrc = readFileSync(
    join(import.meta.dir, '..', 'channels', 'slack', 'dispatch.ts'),
    'utf8',
  );

  test('dispatchSlackEvent uses isOwnBotEvent, not a blanket bot_id gate', () => {
    // Every behavioural test above passes even if the call site still returns on
    // any bot, because they exercise the function directly. Pin the call site.
    const body = dispatchSrc.slice(dispatchSrc.indexOf('export async function dispatchSlackEvent'));
    expect(body, 'the self-identity gate is gone — the bot would answer its own messages in a loop')
      .toContain('if (isOwnBotEvent(event, botUserId)) return;');
    expect(
      body.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n'),
      'the blanket `|| event.bot_id` gate is back — every other bot is silently dropped again',
    ).not.toMatch(/\|\|\s*event\.bot_id\s*\)\s*return/);
  });

  test('no username/icon override in the Slack send path — that is what keeps event.user ours', () => {
    // isOwnBotEvent identifies our messages by event.user. Slack only sets that
    // when a post goes out as the bot itself; posting with username/icon_emoji/
    // icon_url instead yields bot_message with NO user, and the self-loop guard
    // would stop matching. If this test ever reds, the fix is to key the guard on
    // a stored bot_id (auth.test returns one) — not to delete this test.
    const dir = join(import.meta.dir, '..', 'channels', 'slack');
    const glob = new Bun.Glob('**/*.ts');
    const offenders: string[] = [];
    for (const rel of glob.scanSync({ cwd: dir })) {
      if (rel.includes('__tests__') || rel.endsWith('.test.ts')) continue;
      const src = readFileSync(join(dir, rel), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      if (/\b(username|icon_emoji|icon_url)\s*:/.test(src)) offenders.push(rel);
    }
    expect(offenders, 'a post with a username/icon override arrives with NO event.user, weakening isOwnBotEvent')
      .toEqual([]);
  });
});

// ── The gate AFTER isOwnBotEvent, which is why #6577 alone did not work ──────
//
// Opening the bot gate was necessary and not sufficient. The mention then hits
// SLACK_REQUIRE_USER_IDENTITY (optBoolTrue — ON by default): resolveSlackActor
// looks up chat_user_identities by the SENDER's Slack user id, a bot has no row,
// so it answers `unlinked` and dispatch returns before the turn.
//
// Worse, it returned LOUDLY into a void: postIdentityPrompt posts an ephemeral
// AND opens a DM, both addressed to slackUserId — the bot. Nobody sees either,
// so the mention reads as "Kortix ignored it". Verified on dev f07c04f0 with a
// real bot-to-bot mention (Slack ts 1787153374.887479).

describe('a bot sender is never sent an identity prompt', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'channels', 'slack', 'dispatch.ts'), 'utf8');

  test('postIdentityPrompt is guarded on the sender not being a bot', () => {
    // BOTH sites: the bare-@mention branch and the main turn path. Checking only
    // the first is how the second stayed unguarded — this test caught that.
    const sites = [...src.matchAll(/await postIdentityPrompt\(/g)];
    expect(sites.length, 'expected two identity-prompt sites').toBe(2);
    for (const m of sites) {
      const before = src.slice(Math.max(0, m.index! - 400), m.index!);
      expect(before, 'an unlinked BOT gets an ephemeral + a DM it cannot read, and the mention looks ignored')
        .toContain('if (!event.bot_id) {');
    }
  });

  test('link-bot is routed and identity-flag gated', () => {
    const cmds = readFileSync(join(import.meta.dir, '..', 'channels', 'slack', 'commands.ts'), 'utf8');
    expect(cmds, 'the only way to make a bot resolvable is gone').toContain("case 'link-bot':");
    expect(cmds, 'link-bot must write the same chat_user_identities row /login does')
      .toContain('await linkSlackIdentity({ teamId: ctx.teamId, slackUserId: botUserId, userId: me.userId });');
    const h = cmds.slice(cmds.indexOf('async function slashLinkBot'));
    expect(h.slice(0, 1600), 'linking a bot must stay owner/admin gated — any app in the channel is a non-member')
      .toContain('canManageSlackPolicy');
  });
});
