import { describe, expect, test } from 'bun:test';
import type { AgentCapabilityGrant } from '@kortix/sdk';

import { capabilityModeGrant } from './capability-library';

const IDS = ['kortix-system', 'kortix-genui', 'pdf'];

function drive(value: AgentCapabilityGrant | undefined) {
  let written: AgentCapabilityGrant | undefined;
  const grant = capabilityModeGrant(value, IDS, 'none', (next) => {
    written = next;
  });
  return { grant, written: () => written };
}

describe('capabilityModeGrant', () => {
  test('{ exclude } reads as All, with the excluded row off', () => {
    const { grant } = drive({ exclude: ['kortix-genui'] });
    expect(grant.mode).toBe('all');
    expect(grant.isGranted('kortix-system')).toBe(true);
    expect(grant.isGranted('kortix-genui')).toBe(false);
  });

  test('Specific keeps every row that is on, built-ins included', () => {
    const run = drive({ exclude: ['kortix-genui'] });
    run.grant.setMode('specific');
    expect(run.written()).toEqual(['kortix-system', 'pdf']);
  });

  test('Specific from None with nothing on stays None', () => {
    const run = drive(undefined);
    expect(run.grant.mode).toBe('none');
    run.grant.setMode('specific');
    expect(run.written()).toBe('none');
  });

  test('one row off under All writes the exclude form', () => {
    const run = drive('all');
    run.grant.toggle('kortix-system');
    expect(run.written()).toEqual({ exclude: ['kortix-system'] });
  });
});
