import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'use-voice-settings.ts'), 'utf8');

describe('voice settings SDK boundary', () => {
  test('imports setMeetBotName from the canonical SDK entry point', () => {
    expect(source).toContain("import { setMeetBotName } from '@kortix/sdk';");
    expect(source).not.toContain('@kortix/sdk/projects-client');
  });
});
