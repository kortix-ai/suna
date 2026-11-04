import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ARTIFACT_LIVE_LIMITS } from '@kortix/shared/artifact-live';
import {
  consumeArtifactLiveTicket,
  markArtifactLiveTicketUsed,
  mintArtifactLiveTicket,
  verifyArtifactLiveTicket,
  type ArtifactLiveTicketClaims,
} from './live-ticket';

const PROJECT = '40000000-0000-4000-8000-000000000001';
const ARTIFACT = '40000000-0000-4000-8000-000000000002';
const OTHER = '40000000-0000-4000-8000-000000000003';
const claims: ArtifactLiveTicketClaims = {
  p: PROJECT, a: ARTIFACT, u: '40000000-0000-4000-8000-000000000004', c: '40000000-0000-4000-8000-000000000005',
  k: 'jwt', t: null, s: null, m: 'aal1', g: '40000000-0000-4000-8000-000000000008', x: Date.parse('2026-11-04T11:00:00.000Z'),
};
const T0 = new Date('2026-11-04T10:00:00.000Z');

afterEach(() => setSystemTime());

describe('artifact live tickets', () => {
  test('a ticket verifies for its own Artifact and carries its actor', () => {
    setSystemTime(T0);
    const { ticket, expiresAt } = mintArtifactLiveTicket(claims);
    expect(expiresAt).toBe(T0.getTime() + ARTIFACT_LIVE_LIMITS.ticketMs);
    const verified = verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT });
    expect(verified?.claims).toEqual(claims);
    expect(verified?.expiresAt).toBe(expiresAt);
  });

  test('two tickets for the same actor differ (a random nonce)', () => {
    expect(mintArtifactLiveTicket(claims).ticket).not.toBe(mintArtifactLiveTicket(claims).ticket);
  });

  test('a ticket works once', () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket(claims);
    const verified = verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })!;
    expect(consumeArtifactLiveTicket(verified.digest, verified.expiresAt)).toBe(true);
    expect(consumeArtifactLiveTicket(verified.digest, verified.expiresAt)).toBe(false);
  });

  test('a ticket another replica used is refused here', () => {
    setSystemTime(T0);
    const { ticket, expiresAt } = mintArtifactLiveTicket(claims);
    const verified = verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })!;
    markArtifactLiveTicketUsed(verified.digest, expiresAt);
    expect(consumeArtifactLiveTicket(verified.digest, expiresAt)).toBe(false);
  });

  test(`a ticket expires after ${ARTIFACT_LIVE_LIMITS.ticketMs} ms`, () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket(claims);
    setSystemTime(new Date(T0.getTime() + ARTIFACT_LIVE_LIMITS.ticketMs - 1));
    expect(verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })).not.toBeNull();
    setSystemTime(new Date(T0.getTime() + ARTIFACT_LIVE_LIMITS.ticketMs + 1));
    expect(verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })).toBeNull();
  });

  test('a ticket for another Artifact and garbage are refused', () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket(claims);
    expect(verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: OTHER })).toBeNull();
    expect(verifyArtifactLiveTicket(ticket, { projectId: OTHER, artifactId: ARTIFACT })).toBeNull();
    for (const bad of [null, '', 'x', 'a.b', 'forged.ticket', `${ticket}.`, ticket.slice(0, 20)]) {
      expect(verifyArtifactLiveTicket(bad, { projectId: PROJECT, artifactId: ARTIFACT })).toBeNull();
    }
  });

  test('the ticket is opaque: no claim reads in it, nor in its decoded bytes', () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket({ ...claims, k: 'agent_session', t: '40000000-0000-4000-8000-000000000006', s: '40000000-0000-4000-8000-000000000007' });
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(ticket, 'base64url').toString('latin1');
    for (const text of [ticket, decoded]) {
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      for (const word of ['agent_session', 'aal1', '"p"', 'exp']) expect(text).not.toContain(word);
    }
  });

  test('a ticket with any one byte changed is refused', () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket(claims);
    const bytes = Buffer.from(ticket, 'base64url');
    // The nonce, the first and last sealed bytes, and the tag.
    for (const at of [0, 11, 12, bytes.length - 17, bytes.length - 16, bytes.length - 1]) {
      const changed = Buffer.from(bytes);
      changed[at] = changed[at]! ^ 0x01;
      expect(verifyArtifactLiveTicket(changed.toString('base64url'), { projectId: PROJECT, artifactId: ARTIFACT })).toBeNull();
    }
    expect(verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })).not.toBeNull();
  });

  test('a ticket with an unknown credential kind is refused', () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket({ ...claims, k: 'sandbox' as never });
    expect(verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })).toBeNull();
  });
});

describe('one ticket, one spelling (Strix: non-canonical base64url spellings)', () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  /** A ticket whose last character carries unused bits, and one alias of it. */
  function aliased(): { ticket: string; alias: string } {
    for (let pad = 0; pad < 3; pad++) {
      const { ticket } = mintArtifactLiveTicket({ ...claims, m: `aal${'1'.repeat(pad + 1)}` });
      if (ticket.length % 4 === 0) continue;
      const last = ALPHABET.indexOf(ticket.at(-1)!);
      const alias = ticket.slice(0, -1) + ALPHABET[last ^ 1];
      // The alias decodes to the same bytes: only the unused low bit changed.
      expect(Buffer.from(alias, 'base64url').equals(Buffer.from(ticket, 'base64url'))).toBe(true);
      return { ticket, alias };
    }
    throw new Error('no ticket length with unused bits');
  }

  test('a non-canonical spelling of a ticket is refused outright', () => {
    setSystemTime(T0);
    const { ticket, alias } = aliased();
    expect(verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })).not.toBeNull();
    expect(verifyArtifactLiveTicket(alias, { projectId: PROJECT, artifactId: ARTIFACT })).toBeNull();
  });

  test('single use is keyed on the sealed nonce, not on the text', () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket(claims);
    const verified = verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })!;
    expect(verified.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.digest).not.toBe(createHash('sha256').update(ticket).digest('hex'));
  });
});

describe('the credential behind the ticket (Strix: revoked or expired sessions)', () => {
  test('a ticket carries the auth session id and the credential expiry', () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket(claims);
    const verified = verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })!;
    expect(verified.claims.g).toBe(claims.g);
    expect(verified.claims.x).toBe(claims.x);
  });

  test('a ticket whose credential already expired is refused', () => {
    setSystemTime(T0);
    const { ticket } = mintArtifactLiveTicket({ ...claims, x: T0.getTime() - 1 });
    expect(verifyArtifactLiveTicket(ticket, { projectId: PROJECT, artifactId: ARTIFACT })).toBeNull();
  });
});
