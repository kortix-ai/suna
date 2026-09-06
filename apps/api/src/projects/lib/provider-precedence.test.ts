import { describe, expect, it } from 'bun:test';
import { resolvePiWorkerProvider } from './provider-precedence';

describe('resolvePiWorkerProvider — a pin to a provider the deployment lacks is fatal, not conservative', () => {
  // v0 pinned every pi worker session to Daytona with a note to lift it once
  // another adapter was verified. On a Platinum-only deployment that pin killed
  // the session outright: getProvider('daytona') throws "requires
  // DAYTONA_API_KEY" before anything is created (dev, 2026-09-06). Daytona
  // still wins wherever it is configured; elsewhere the session takes the
  // deployment's own provider, which on Platinum boots the worker as a cell.
  it('keeps Daytona wherever Daytona is configured', () => {
    expect(resolvePiWorkerProvider({ allowed: ['daytona'], deploymentProvider: 'daytona' })).toBe('daytona');
    expect(resolvePiWorkerProvider({ allowed: ['daytona', 'platinum'], deploymentProvider: 'platinum' })).toBe('daytona');
    expect(resolvePiWorkerProvider({ allowed: ['platinum', 'daytona'], deploymentProvider: 'platinum' })).toBe('daytona');
  });

  it('takes the deployment provider when Daytona is not configured at all', () => {
    expect(resolvePiWorkerProvider({ allowed: ['platinum'], deploymentProvider: 'platinum' })).toBe('platinum');
    expect(resolvePiWorkerProvider({ allowed: ['e2b'], deploymentProvider: 'e2b' })).toBe('e2b');
  });

  it('never invents a provider the deployment did not allow', () => {
    for (const allowed of [['platinum'], ['e2b'], ['platinum', 'e2b']]) {
      const picked = resolvePiWorkerProvider({ allowed, deploymentProvider: allowed[0] });
      expect(allowed).toContain(picked);
    }
  });
});
