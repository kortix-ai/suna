/**
 * Live harness for `features/login` (wave 2). Not a unit test — it needs a real
 * API and a real token, so `bun test` never runs it.
 *
 *   KORTIX_CONFIG_FILE=/tmp/tui-login-config.json \
 *   KORTIX_LOGIN_URL=http://localhost:17408 \
 *   KORTIX_API_KEY=<jwt-or-pat> \
 *   bun run scripts/dev-login.tsx
 *
 * `KORTIX_CONFIG_FILE` is MANDATORY and must not be the real
 * `~/.config/kortix/config.json`: this harness writes a host record, and a
 * scratch run must never touch the user's own credentials. The harness refuses
 * to start otherwise.
 *
 * `--interactive` drives it in this terminal instead of the test renderer.
 *
 * The token is read from the environment. It is never written to a file this
 * harness controls, never printed, and never reaches a captured frame — the
 * config dump redacts every `token` field, and the frame assertion below fails
 * the run if any prefix of the token appears on screen.
 *
 * Each phase gets its OWN test renderer. Re-rendering a second tree into one
 * root left the previous mount's `<input>` renderables holding the keyboard, so
 * text typed after a re-render landed nowhere — a harness artefact, not a
 * product bug, and one fresh renderer per phase removes it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createCliRenderer } from '@opentui/core';
import { type TestRendererSetup, createTestRenderer } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';

import { configFilePath } from '@kortix/cli/src/api/config.ts';

import { listHostEntries } from '../src/auth/hosts.ts';
import { LoginScreen } from '../src/features/login/index.ts';

const INTERACTIVE = process.argv.includes('--interactive');
const WIDTH = 84;
const HEIGHT = 20;

const configPath = process.env.KORTIX_CONFIG_FILE?.trim();
const realConfig = resolve(homedir(), '.config', 'kortix', 'config.json');
if (!configPath) throw new Error('set KORTIX_CONFIG_FILE to a scratch path first');
if (resolve(configPath) === realConfig) {
  throw new Error('refusing to run against the real ~/.config/kortix/config.json');
}

const token = process.env.KORTIX_API_KEY?.trim() || process.env.KORTIX_TOKEN?.trim();
if (!token) throw new Error('set KORTIX_API_KEY to a real PAT or JWT');
const apiUrl = process.env.KORTIX_LOGIN_URL?.trim() || 'http://localhost:17408';
const hostName = process.env.KORTIX_LOGIN_HOST?.trim() || 'tui-live';

function banner(title: string): void {
  console.log(`\n===== ${new Date().toISOString().slice(11, 19)} ${title} =====`);
}

/** The stored config with every credential replaced. Safe to print. */
function redactedConfig(): string {
  if (!existsSync(configFilePath())) return '(no config file written)';
  const parsed = JSON.parse(readFileSync(configFilePath(), 'utf8')) as {
    active: string;
    hosts: Record<string, Record<string, unknown>>;
  };
  for (const host of Object.values(parsed.hosts)) {
    const stored = typeof host.token === 'string' ? host.token : '';
    host.token = stored
      ? `«REDACTED ${stored.length} chars · matches KORTIX_API_KEY: ${stored === token}»`
      : '';
  }
  return JSON.stringify(parsed, null, 2);
}

const loggedIn: Array<Record<string, unknown>> = [];
const toasts: string[] = [];

function Harness() {
  return (
    <LoginScreen
      hosts={listHostEntries()}
      width={WIDTH}
      height={HEIGHT}
      onLoggedIn={(resolved) => {
        // The resolved host CARRIES the token. Print everything but that.
        const { token: secret, ...rest } = resolved;
        loggedIn.push({ ...rest, token: `«REDACTED ${secret.length} chars»` });
        console.log(`[onLoggedIn] ${JSON.stringify({ ...rest, token: '«REDACTED»' })}`);
      }}
      onQuit={() => console.log('[onQuit]')}
      onToast={(message, kind) => {
        toasts.push(`${kind ?? 'info'}: ${message}`);
        console.log(`[toast/${kind ?? 'info'}] ${message}`);
      }}
      onHostsChanged={() => console.log('[onHostsChanged]')}
    />
  );
}

console.log(
  `config=${configFilePath()} api=${apiUrl} host=${hostName} tokenLength=${token.length}`,
);

if (INTERACTIVE) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(<Harness />);
} else {
  interface Phase {
    setup: TestRendererSetup;
    frame(): string;
    settle(ms: number): Promise<void>;
    press(key: string, ms?: number): Promise<void>;
    typeInto(text: string): Promise<void>;
    clearField(): Promise<void>;
    end(): void;
  }

  async function startPhase(): Promise<Phase> {
    const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
    const root = createRoot(setup.renderer);
    root.render(<Harness />);
    const settle = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        await setup.renderOnce();
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    await settle(400);
    return {
      setup,
      frame: () => setup.captureCharFrame(),
      settle,
      press: async (key, ms = 160) => {
        setup.mockInput.pressKey(key);
        await settle(ms);
      },
      typeInto: async (text) => {
        await setup.mockInput.typeText(text, 2);
        await settle(200);
      },
      clearField: async () => {
        for (let step = 0; step < 48; step += 1) setup.mockInput.pressBackspace();
        await settle(200);
      },
      end: () => {
        root.unmount();
        setup.renderer.destroy();
      },
    };
  }

  // ── Phase 1: add a host with the real token ───────────────────────────────
  const add = await startPhase();
  banner('FRAME 1 — the host list from the scratch config');
  console.log(add.frame());

  await add.press('n');
  banner('FRAME 2 — the add-host form');
  console.log(add.frame());

  await add.typeInto(hostName);
  add.setup.mockInput.pressTab();
  await add.settle(120);
  await add.clearField();
  await add.typeInto(apiUrl);
  add.setup.mockInput.pressTab();
  await add.settle(120);
  banner('FRAME 3 — name and URL entered, cursor on the token field');
  console.log(add.frame());

  // A real token arrives by bracketed paste, not by 779 keystrokes.
  await add.setup.mockInput.pasteBracketedText(token);
  await add.settle(300);
  banner('FRAME 4 — the token, masked');
  console.log(add.frame());
  if (add.frame().includes(token.slice(0, 12))) throw new Error('the token leaked into the frame');

  add.setup.mockInput.pressEnter();
  await add.settle(8000);
  banner('FRAME 5 — after the real /accounts/me round trip');
  console.log(add.frame());
  if (loggedIn.length !== 1) throw new Error('expected exactly one successful login');
  add.end();

  banner('THE SAVED CONFIG FILE (tokens redacted)');
  console.log(redactedConfig());

  // ── Phase 2: a second launch resolves the stored host with no token entry ──
  banner('RELAUNCH — a fresh mount reading the config that was just written');
  loggedIn.length = 0;
  const relaunch = await startPhase();
  console.log(`host rows: ${JSON.stringify(listHostEntries().map((entry) => entry.name))}`);
  console.log(relaunch.frame());
  relaunch.setup.mockInput.pressEnter();
  await relaunch.settle(600);
  console.log(`onLoggedIn after relaunch: ${JSON.stringify(loggedIn, null, 2)}`);
  if (loggedIn.length !== 1) throw new Error('a stored host did not resolve on relaunch');
  relaunch.end();

  // ── Phase 3: a rejected token renders the API's own status and saves nothing ─
  banner('NEGATIVE — a token the API rejects');
  const before = listHostEntries().map((entry) => entry.name);
  const bad = await startPhase();
  await bad.press('n');
  await bad.typeInto('tui-live-bad');
  bad.setup.mockInput.pressTab();
  await bad.settle(120);
  await bad.clearField();
  await bad.typeInto(apiUrl);
  bad.setup.mockInput.pressTab();
  await bad.settle(120);
  await bad.setup.mockInput.pasteBracketedText('kortix_pat_definitely_not_a_real_token');
  await bad.settle(200);
  bad.setup.mockInput.pressEnter();
  await bad.settle(8000);
  console.log(bad.frame());
  const after = listHostEntries().map((entry) => entry.name);
  console.log(`hosts before: ${JSON.stringify(before)}`);
  console.log(`hosts after:  ${JSON.stringify(after)}`);
  if (after.includes('tui-live-bad')) throw new Error('a rejected token was saved');
  bad.end();

  banner('SUMMARY');
  console.log(JSON.stringify({ toasts, loggedIn }, null, 2));
  process.exit(0);
}
