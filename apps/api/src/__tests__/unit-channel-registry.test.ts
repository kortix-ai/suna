// Locks in the channel connector descriptor registry contract + the exact auth
// lane chosen for each runtime capability (each mirrors the gate the old
// bespoke /channels/* route enforced — see routes/connectors-channels.ts).
import { describe, expect, test } from 'bun:test';
import { descriptorForPlatform, listChannelDescriptors } from '../channels/registry';

describe('channel descriptor registry', () => {
  test('registers exactly slack, teams, email, meet', () => {
    const platforms = listChannelDescriptors()
      .map((d) => d.platform)
      .sort();
    expect(platforms).toEqual(['email', 'meet', 'slack', 'teams']);
  });

  test('descriptorForPlatform resolves known platforms + rejects unknown', () => {
    expect(descriptorForPlatform('email')?.platform).toBe('email');
    expect(descriptorForPlatform('slack')?.reservedSlug).toBe('kortix_slack');
    expect(descriptorForPlatform('meet')?.reservedSlug).toBe('kortix_meet');
    expect(descriptorForPlatform('nope')).toBeNull();
  });

  test('every descriptor is inbound + has a reserved slug', () => {
    for (const d of listChannelDescriptors()) {
      expect(d.direction).toBe('inbound');
      expect(d.reservedSlug).toMatch(/^kortix_/);
    }
  });

  test('email exposes updatePolicy as a write capability', () => {
    expect(descriptorForPlatform('email')!.capabilities.updatePolicy?.access).toBe('write');
  });

  test('slack: bind-thread uses the sandbox session lane; uploadFile=write; getFile=member', () => {
    const d = descriptorForPlatform('slack')!;
    expect(d.capabilities.bindThread?.access).toBe('session');
    expect(d.capabilities.uploadFile?.access).toBe('write');
    expect(d.capabilities.getFile?.access).toBe('member');
  });

  test('slack has NO manifest capability (public webhook route stays separate)', () => {
    expect(descriptorForPlatform('slack')!.capabilities.manifest).toBeUndefined();
  });

  test('meet: name/voice require customize-write; speak=write; voices=member', () => {
    const d = descriptorForPlatform('meet')!;
    expect(d.capabilities.setName?.access).toBe('customize');
    expect(d.capabilities.setVoice?.access).toBe('customize');
    expect(d.capabilities.speak?.access).toBe('write');
    expect(d.capabilities.voices?.access).toBe('member');
    expect(d.capabilities.previewVoice?.access).toBe('member');
  });

  test('teams uploadFile preserves its member-only gate (not tightened to write)', () => {
    expect(descriptorForPlatform('teams')!.capabilities.uploadFile?.access).toBe('member');
  });
});
