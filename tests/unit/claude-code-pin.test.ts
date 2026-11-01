import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The API image runs `claude setup-token` for the Claude subscription sign-in,
// and kortixd drives Claude Code through the Claude Agent SDK. Both must be the
// same Claude Code release: the sign-in and the turns it serves come from one
// pinned SDK version.

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('Claude Code pin', () => {
  it('the API image installs the Claude Agent SDK version kortixd depends on', () => {
    const image = /^ARG CLAUDE_AGENT_SDK_VERSION=(\S+)$/m.exec(read('apps/api/Dockerfile'))?.[1];
    const kortixd = JSON.parse(read('apps/kortix-sandbox-agent-server/package.json')).dependencies['@anthropic-ai/claude-agent-sdk'];
    expect(image).toMatch(/^\d+\.\d+\.\d+$/);
    expect(image).toBe(kortixd);
  });
});
