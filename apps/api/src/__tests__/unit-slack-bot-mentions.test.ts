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
  isBotUser: async () => true,
  findBotUserIdByName: async () => null,
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

// Extract a whole top-level function body. Fixed-length slices (…, i + 2600)
// silently stop reaching their assertions the moment the function grows, which
// is exactly what happened when link-bot learned to resolve names: three tests
// went red without the behaviour changing at all.
function fnBody(src: string, name: string): string {
  const i = src.indexOf(`async function ${name}`);
  if (i < 0) return '';
  const nextFn = src.indexOf('\nasync function ', i + 1);
  const nextTop = src.indexOf('\nfunction ', i + 1);
  const ends = [nextFn, nextTop, src.length].filter((n) => n > 0);
  return src.slice(i, Math.min(...ends));
}


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
    const h = fnBody(cmds, 'slashLinkBot');
    // NOT owner/admin. Linking binds the bot to the CALLER's own account, so it
    // delegates the caller's authority and can never exceed it — the same shape
    // as issuing yourself an API key. An admin-only gate was actively wrong: an
    // admin linking a channel-triggerable bot is MORE dangerous than a member
    // doing it. The gate is the one every Slack message already passes.
    expect(h, 'the gate must be "could you have done this work yourself", via resolveSlackActor')
      .toContain('resolveSlackActor(ctx.teamId, ctx.slackUserId, proj.accountId, selection.projectId)');
    expect(h, 'an owner/admin requirement is the wrong shape for self-delegation')
      .not.toContain('canManageSlackPolicy');
  });
});

// ── link-bot must never bind a HUMAN ────────────────────────────────────────
//
// Flagged on #6590 by review, and it was real. linkSlackIdentity UPSERTS, and
// resolveSlackActor treats the row as the authoritative
// (workspace, slack_user) -> kortix_user mapping, so binding a person's id would
// silently make THEIR later Slack actions run as whoever linked them. Human and
// bot ids are the same shape — /^[UWB][A-Z0-9]{6,}$/ matches U0B8ERR54BH (a
// person) exactly as it matches a bot — so only Slack can tell them apart.

describe('link-bot refuses anything that is not a verified bot', () => {
  const cmds = readFileSync(join(import.meta.dir, '..', 'channels', 'slack', 'commands.ts'), 'utf8');
  const handler = fnBody(cmds, 'slashLinkBot');

  test('Slack is asked whether the target is a bot, BEFORE the link is written', () => {
    const askedAt = handler.indexOf('isBotUser(');
    const wroteAt = handler.indexOf('await linkSlackIdentity(');
    expect(askedAt, 'no bot verification — a human id would be accepted').toBeGreaterThan(-1);
    expect(wroteAt).toBeGreaterThan(-1);
    expect(askedAt, 'the link must not be written before the check').toBeLessThan(wroteAt);
  });

  test('anything other than a definite yes refuses — null (unknown) included', () => {
    // isBotUser returns null on missing scope / transport error / unknown user.
    // `bot !== true` is load-bearing: `!bot` would also refuse, but a truthy
    // check like `bot === false` alone would let null through and link a human.
    expect(handler, 'uncertainty must refuse, not fall through').toContain('if (bot !== true) {');
  });

  test('the link is always to the CALLER — never to a third party', () => {
    // This is what makes the relaxed gate safe: you can only ever delegate your
    // own authority, so there is no privilege to escalate.
    const h = fnBody(readFileSync(join(import.meta.dir, '..', 'channels', 'slack', 'commands.ts'), 'utf8'), 'slashLinkBot');
    expect(h).toContain('userId: me.userId');
  });

  test('an id already linked to someone else is never silently re-pointed', () => {
    expect(handler, 'upsert would overwrite an existing human mapping')
      .toContain("existing && existing.userId !== me.userId");
  });

  test('isBotUser itself fails closed', () => {
    const api = readFileSync(join(import.meta.dir, '..', 'channels', 'slack-api.ts'), 'utf8');
    const fn = api.slice(api.indexOf('export async function isBotUser'));
    // Scope the assertion to the !r.ok BLOCK. A greedy match across the whole
    // function passes even when this branch returns false, because two later
    // `return null` lines exist — the negative control caught that.
    const i = fn.indexOf('if (!r.ok) {');
    expect(i, 'no failure branch at all').toBeGreaterThan(-1);
    const branch = fn.slice(i, fn.indexOf('}', fn.indexOf('return', i)));
    expect(branch, 'a failed users.info must be null (unknown) — false would read as "a human", and refuse every bot')
      .toContain('return null;');
    expect(branch, 'never answer false/true from a failed lookup').not.toMatch(/return (false|true);/);
  });
});

// ── the usage that could not work ───────────────────────────────────────────
//
// The slash command is registered should_escape:false, so Slack sends
// "@Incident reporter" LITERALLY — never <@U…>. v1 accepted only an id and its
// usage text said `link-bot @TheBot`: it documented the single form that cannot
// work, and that is exactly what came back in the channel.

describe('link-bot accepts what an operator will actually type', () => {
  const cmds = readFileSync(join(import.meta.dir, '..', 'channels', 'slack', 'commands.ts'), 'utf8');
  const h = fnBody(cmds, 'slashLinkBot');

  test('a plain name is resolved, not rejected', () => {
    expect(h, 'a bare name must be looked up — Slack never expands it to <@U…>')
      .toContain('findBotUserIdByName(token, raw)');
  });

  test('the failure message tells you where to get a member ID', () => {
    expect(h, 'usage must not point at a form that cannot work').not.toContain('link-bot @TheBot');
    expect(h, 'give the operator the copy-member-ID path').toContain('Copy member ID');
  });

  test('name resolution still goes through the is-a-bot check', () => {
    // Resolving by name must not become a second, unguarded way in.
    const byName = h.indexOf('findBotUserIdByName');
    const verify = h.indexOf('isBotUser(');
    const write  = h.indexOf('await linkSlackIdentity(');
    expect(byName).toBeLessThan(verify);
    expect(verify).toBeLessThan(write);
  });
});

// ── users.* must be form-encoded ────────────────────────────────────────────
//
// Slack's older read methods do not parse a JSON body: the params are dropped
// and the call is answered as if they were never sent. users.info replies
// `user_not_found` for an id Slack itself just returned from users.list and
// renders fine as <@ID>. Measured on dev 2026-08-19, /ecs/kortix-dev:
//
//   [slack-api] users.info failed { error: "user_not_found" }
//
// It reads as bad data rather than a bad request, which is why it survived
// review and a live test.

describe('slack-api sends users.* as form-encoded, not JSON', () => {
  const api = readFileSync(join(import.meta.dir, '..', 'channels', 'slack-api.ts'), 'utf8');

  test('users.info passes form:true', () => {
    expect(api, 'users.info with a JSON body silently drops `user` and answers user_not_found')
      .toContain("slackApiCall(token, 'users.info', { user: userId }, { form: true })");
  });

  test('users.list passes form:true', () => {
    expect(api).toContain("slackApiCall(token, 'users.list', { limit: 1000 }, { form: true })");
  });

  test('the form branch actually changes the Content-Type and the body', () => {
    // A `form` option that only sets a header would encode nothing.
    expect(api).toContain('application/x-www-form-urlencoded');
    expect(api, 'form mode must URL-encode the params, not JSON.stringify them')
      .toContain('new URLSearchParams(');
  });
});
