import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { ARTIFACT_LIVE_LIMITS } from '@kortix/shared/artifact-live';
import {
  artifactLiveTicketDigest,
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
  k: 'jwt', t: null, s: null, m: 'aal1',
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
    expect(consumeArtifactLiveTicket(ticket, verified.expiresAt)).toBe(true);
    expect(consumeArtifactLiveTicket(ticket, verified.expiresAt)).toBe(false);
  });

  test('a ticket another replica used is refused here', () => {
    setSystemTime(T0);
    const { ticket, expiresAt } = mintArtifactLiveTicket(claims);
    markArtifactLiveTicketUsed(artifactLiveTicketDigest(ticket), expiresAt);
    expect(consumeArtifactLiveTicket(ticket, expiresAt)).toBe(false);
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
