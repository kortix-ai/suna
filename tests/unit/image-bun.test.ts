import { describe, expect, it } from 'vitest';
import { readRepoFile as read } from '../src/fixtures/repo';

// The API and LLM gateway images run the same Bun as every test lane. When they differed
// (API image 1.2.23, tests 1.3/1.4), a Web API the image lacked passed every test and
// answered 500 on dev: CompressionStream in the global compress middleware (2026-08-26)
// and in the session-log restore route (2026-10-13).

describe('image Bun', () => {
  it.each(['apps/api/Dockerfile', 'apps/llm-gateway/Dockerfile'])('%s equals the Bun of the test lanes', (dockerfile) => {
    const image = /^ARG BUN_VERSION=(\S+)$/m.exec(read(dockerfile))?.[1];
    const tests = /bun-version: (\S+)/.exec(read('.github/workflows/tests.yml'))?.[1];
    expect(image).toMatch(/^\d+\.\d+\.\d+$/);
    expect(image).toBe(tests);
  });
});
