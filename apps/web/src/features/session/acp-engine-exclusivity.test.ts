/**
 * Structural pin: the ACTIVE conversation surface (`AcpSessionChat` and its
 * direct support module family) must render exclusively from the ACP
 * engine's `AcpChatItem` projection — never from the deprecated
 * OpenCode-wire projection stack (`@kortix/sdk`'s `classifyPart` /
 * `classifyTurn` / `toolViewModel` / `toolInfo` / `normalizeToolName` /
 * `humanizeToolName` / `formatTranscript` / `getTranscriptFilename`, all
 * `@deprecated` per `packages/sdk/src/transcript.ts` and
 * `packages/sdk/src/core/turns/*`).
 *
 * `acp-session-chat.test.tsx` already pins the *behavioral* half of this
 * claim — every fixture in that 700+-line suite is built via
 * `projectAcpChatItems` and handed to the component purely as `chatItems`.
 * This test pins the complementary *structural* half: a source scan proving
 * none of these files even import the deprecated names, so the claim can't
 * quietly go stale as the component grows. `@/ui` is included in the ban
 * list because it re-exports `@kortix/sdk/turns` wholesale
 * (`apps/web/src/ui/index.ts`), so `import { classifyPart } from '@/ui'`
 * would be just as real a dependency as importing it from the SDK directly.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_DIR = join(import.meta.dir);

/** The live ACP chat surface: the chat component itself plus every
 *  framework-free/React support module it's built from. Deliberately does
 *  NOT include `acp-session-chat.test.tsx` or other test files — this is a
 *  source scan of shipped code, not test fixtures. */
const ACP_LIVE_SURFACE_FILES = [
  'acp-session-chat.tsx',
  'acp-chat-item-row.tsx',
  'acp-composer-adapters.ts',
  'acp-request-cards.tsx',
  'acp-session-permission-prompt.tsx',
  'acp-tool-call-card.tsx',
  'acp-transcript-groups.tsx',
  'acp-turn-grouping.ts',
];

const DEPRECATED_OPENCODE_WIRE_NAMES = [
  'classifyPart',
  'classifyTurn',
  'toolViewModel',
  'toolInfo',
  'normalizeToolName',
  'humanizeToolName',
  'formatTranscript',
  'getTranscriptFilename',
];

describe('ACP live chat surface — no OpenCode-wire dependency', () => {
  for (const file of ACP_LIVE_SURFACE_FILES) {
    test(`${file} does not import any deprecated OpenCode-wire projection export`, () => {
      const source = readFileSync(join(SESSION_DIR, file), 'utf8');
      for (const name of DEPRECATED_OPENCODE_WIRE_NAMES) {
        // Match the name only as an imported identifier (word boundary), not
        // as a substring of an unrelated identifier.
        const importedAsIdentifier = new RegExp(`\\b${name}\\b`).test(source);
        expect(importedAsIdentifier).toBe(false);
      }
    });
  }
});
