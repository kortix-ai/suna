import { describe, expect, test } from 'bun:test';
import type {
  AssistantMessage,
  EventMessagePartDelta,
  EventMessagePartRemoved,
  EventMessagePartUpdated,
  EventMessageRemoved,
  EventMessageUpdated,
  EventPermissionAsked,
  EventPermissionReplied,
  EventQuestionAsked,
  EventQuestionRejected,
  EventQuestionReplied,
  EventSessionError,
  EventSessionIdle,
  EventSessionStatus,
  EventTodoUpdated,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  UserMessage,
} from '@opencode-ai/sdk/v2/client';
import type {
  KortixAssistantMessageInfo,
  KortixMessageInfo,
  KortixPart,
  KortixSessionEvent,
  KortixUserMessageInfo,
  RuntimePermissionRequest,
  RuntimeQuestionRequest,
} from '@kortix/api-contract/transcript';
import { KORTIX_TRANSCRIPT_SCHEMA } from '@kortix/api-contract/transcript';

/**
 * The OpenCode adapter passes OpenCode's frames through as Kortix frames
 * (`kortix.transcript.v1` keeps OpenCode 1.18's field names). These type
 * assertions fail `tsc` when an OpenCode release the sandbox runs
 * (`@opencode-ai/sdk` pinned to `OPENCODE_SDK_VERSION`) stops fitting the
 * Kortix types. Then `harness/open-code/` needs a real translator for the
 * frame that changed; the Kortix types do not change.
 */
type Fits<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;
type EventOf<T extends KortixSessionEvent['type']> = Extract<KortixSessionEvent, { type: T }>;

export type TranscriptConformance = [
  Assert<Fits<Message, KortixMessageInfo>>,
  Assert<Fits<UserMessage, KortixUserMessageInfo>>,
  Assert<Fits<AssistantMessage, KortixAssistantMessageInfo>>,
  Assert<Fits<Part, KortixPart>>,
  Assert<Fits<PermissionRequest, RuntimePermissionRequest>>,
  Assert<Fits<QuestionRequest, RuntimeQuestionRequest>>,
  Assert<Fits<EventMessageUpdated, EventOf<'message.updated'>>>,
  Assert<Fits<EventMessageRemoved, EventOf<'message.removed'>>>,
  Assert<Fits<EventMessagePartUpdated, EventOf<'message.part.updated'>>>,
  Assert<Fits<EventMessagePartRemoved, EventOf<'message.part.removed'>>>,
  Assert<Fits<EventMessagePartDelta, EventOf<'message.part.delta'>>>,
  Assert<Fits<EventSessionStatus, EventOf<'session.status'>>>,
  Assert<Fits<EventSessionIdle, EventOf<'session.idle'>>>,
  Assert<Fits<EventSessionError, EventOf<'session.error'>>>,
  Assert<Fits<EventPermissionAsked, EventOf<'permission.asked'>>>,
  Assert<Fits<EventPermissionReplied, EventOf<'permission.replied'>>>,
  Assert<Fits<EventQuestionAsked, EventOf<'question.asked'>>>,
  Assert<Fits<EventQuestionReplied, EventOf<'question.replied'>>>,
  Assert<Fits<EventQuestionRejected, EventOf<'question.rejected'>>>,
  Assert<Fits<EventTodoUpdated, EventOf<'todo.updated'>>>,
];

describe('Kortix transcript contract', () => {
  test('is kortix.transcript.v1; OpenCode conformance is checked by tsc (TranscriptConformance)', () => {
    expect(KORTIX_TRANSCRIPT_SCHEMA).toBe('kortix.transcript.v1');
  });
});
