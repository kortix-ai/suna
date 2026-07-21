import { describe, expect, test } from 'bun:test';

import {
  shouldMountAcpChat,
  shouldShowAcpBootstrapErrorCard,
  shouldShowSessionBootLoader,
} from './session-page-lifecycle';

describe('session page chat mount lifecycle', () => {
  test('retains an already-ready chat while the runtime temporarily re-switches', () => {
    expect(shouldMountAcpChat({
      switched: false,
      fresh: false,
      shellSubmitted: false,
      chatReady: true,
    })).toBe(true);
  });

  test('does not mount before the runtime switch or before a fresh-session submit', () => {
    expect(shouldMountAcpChat({
      switched: false,
      fresh: false,
      shellSubmitted: false,
      chatReady: false,
    })).toBe(false);
    expect(shouldMountAcpChat({
      switched: true,
      fresh: true,
      shellSubmitted: false,
      chatReady: false,
    })).toBe(false);
  });

  test('mounts a switched existing session and a submitted fresh session', () => {
    expect(shouldMountAcpChat({
      switched: true,
      fresh: false,
      shellSubmitted: false,
      chatReady: false,
    })).toBe(true);
    expect(shouldMountAcpChat({
      switched: true,
      fresh: true,
      shellSubmitted: true,
      chatReady: false,
    })).toBe(true);
  });
});

// The "Connecting" infinite-spinner fix: a session whose ACP bootstrap fails
// or times out BEFORE ever reaching ready must drop boot chrome and show a
// terminal error instead of reporting the backend's last `/start` stage
// (commonly still 'ready') forever. See `AcpSession.runBootstrap`'s
// bootstrap timeout in `@kortix/sdk/acp` for the other half of this fix —
// what actually turns a hung handshake into the `phase: 'error'` these
// predicates react to.
describe('session boot loader / terminal-error visibility', () => {
  test('shows the boot loader while starting', () => {
    expect(shouldShowSessionBootLoader({ phase: 'starting', acpReady: false })).toBe(true);
  });

  test('hides the boot loader once ready', () => {
    expect(shouldShowSessionBootLoader({ phase: 'ready', acpReady: true })).toBe(false);
  });

  test('hides the boot loader once the ACP session has EVER been ready, even if phase regresses', () => {
    // Mirrors `useSession`'s sticky `acp.ready` — a mid-session failure never
    // reopens boot chrome.
    expect(shouldShowSessionBootLoader({ phase: 'starting', acpReady: true })).toBe(false);
  });

  test('hides the boot loader on a terminal pre-readiness error instead of spinning on "Connecting" forever', () => {
    expect(shouldShowSessionBootLoader({ phase: 'error', acpReady: false })).toBe(false);
  });

  test('the terminal ACP error card shows for a pre-readiness error', () => {
    expect(shouldShowAcpBootstrapErrorCard({ isError: true, fatal: false })).toBe(true);
  });

  test('the terminal ACP error card stays hidden when there is no error', () => {
    expect(shouldShowAcpBootstrapErrorCard({ isError: false, fatal: false })).toBe(false);
  });

  test('the terminal ACP error card defers to the more specific sandbox-fatal card', () => {
    // `fatal` (sandbox status 'error'/'stopped') already has its own card
    // with sandbox-provisioning detail and a Restart action — the two
    // terminal branches must never both try to render.
    expect(shouldShowAcpBootstrapErrorCard({ isError: true, fatal: true })).toBe(false);
  });
});
