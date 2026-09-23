/**
 * Compile-time proof that the shared parity fixture satisfies the SDK wire
 * types. `@kortix/shared` cannot depend on `@kortix/sdk`, so the fixture is
 * typed structurally; these assignments fail the mobile `tsc` gate the moment
 * the two drift (a new required field, a renamed status, a narrowed union).
 */

import { describe, expect, test } from 'bun:test';
import type {
  Message,
  MessageWithParts,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  ToolPart,
} from '@kortix/sdk';
import { SESSION_FIXTURE } from '@kortix/shared/session-fixture';

const messages: MessageWithParts[] = SESSION_FIXTURE.messages;
const children: Record<string, MessageWithParts[]> = SESSION_FIXTURE.childSessions;
const infos: Message[] = SESSION_FIXTURE.messages.map((m) => m.info);
const parts: Part[] = SESSION_FIXTURE.messages.flatMap((m) => m.parts);
const busy: SessionStatus = SESSION_FIXTURE.working.status;
const retry: SessionStatus = SESSION_FIXTURE.working.retryStatus;
const questions: QuestionRequest[] = SESSION_FIXTURE.questions;
const permissions: PermissionRequest[] = SESSION_FIXTURE.permissions;

describe('session fixture — SDK type conformance', () => {
  test('the typed views are the fixture itself', () => {
    expect(messages).toBe(SESSION_FIXTURE.messages);
    expect(children).toBe(SESSION_FIXTURE.childSessions);
    expect(infos.length).toBe(messages.length);
    expect(parts.some((p): p is ToolPart => p.type === 'tool')).toBe(true);
    expect([busy.type, retry.type]).toEqual(['busy', 'retry']);
    expect(questions.length).toBe(1);
    expect(permissions.length).toBe(1);
  });
});
