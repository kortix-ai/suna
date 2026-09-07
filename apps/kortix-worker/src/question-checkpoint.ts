import { isDeepStrictEqual } from 'node:util';
import type { QuestionRequest } from '@opencode-ai/sdk/v2';
import { validateAnswers, validateQuestions } from './question-broker.ts';
import type { SessionLog, SessionLogItem } from './session-store.ts';
import { sessionLogAppendId } from './session-log-id.ts';

export const QUESTION_CHECKPOINT_STREAM = 'kortix.pi.question-checkpoints.v1';
export type QuestionResolution = { answers: string[][] } | { rejected: true };
export interface QuestionCheckpoint {
  turnMessageId: string;
  toolCallId: string;
  request: QuestionRequest;
  resolution: QuestionResolution | null;
  released: boolean;
}

function requiredString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('invalid question checkpoint identity');
}

function requestValue(value: unknown): QuestionRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid question checkpoint request');
  const request = structuredClone(value) as QuestionRequest;
  requiredString(request.id);
  requiredString(request.sessionID);
  requiredString(request.tool?.messageID);
  requiredString(request.tool?.callID);
  validateQuestions(request.questions);
  return request;
}

function resolutionValue(request: QuestionRequest, value: unknown): QuestionResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid question resolution');
  const resolution = value as Record<string, unknown>;
  if (Object.keys(resolution).length === 1 && resolution.rejected === true)
    return { rejected: true };
  if (Object.keys(resolution).length !== 1 || !Array.isArray(resolution.answers))
    throw new Error('invalid question resolution');
  validateAnswers(request, resolution.answers as string[][]);
  return { answers: structuredClone(resolution.answers) as string[][] };
}

function reduce(items: readonly SessionLogItem[]): Map<string, QuestionCheckpoint> {
  const values = new Map<string, QuestionCheckpoint>();
  for (const item of items) {
    if (item.kind !== 'journal' || item.stream !== QUESTION_CHECKPOINT_STREAM) continue;
    const record = item.record;
    if (record.type === 'opened') {
      requiredString(record.turnMessageId);
      requiredString(record.toolCallId);
      const request = requestValue(record.request);
      const candidate: QuestionCheckpoint = {
        turnMessageId: record.turnMessageId,
        toolCallId: record.toolCallId,
        request,
        resolution: null,
        released: false,
      };
      const previous = values.get(request.id);
      if (previous) {
        if (!isDeepStrictEqual({ ...previous, resolution: null, released: false }, candidate))
          throw new Error('conflicting question checkpoint');
        continue;
      }
      if (
        [...values.values()].some(
          (value) => value.turnMessageId === candidate.turnMessageId && !value.released,
        )
      )
        throw new Error('another question checkpoint is active');
      values.set(request.id, candidate);
      continue;
    }
    requiredString(record.requestId);
    const checkpoint = values.get(record.requestId);
    if (!checkpoint) throw new Error('unknown question checkpoint');
    if (record.type === 'resolved') {
      const resolution = resolutionValue(checkpoint.request, record.resolution);
      if (checkpoint.resolution && !isDeepStrictEqual(checkpoint.resolution, resolution))
        throw new Error('conflicting question resolution');
      checkpoint.resolution = resolution;
    } else if (record.type === 'released') {
      if (!checkpoint.resolution)
        throw new Error('cannot release an unresolved question checkpoint');
      checkpoint.released = true;
    } else {
      throw new Error('invalid question checkpoint transition');
    }
  }
  return values;
}

export class QuestionCheckpointStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly log: SessionLog) {}

  async active(turnMessageId: string): Promise<QuestionCheckpoint | null> {
    return (
      [...reduce(await this.log.read()).values()].find(
        (value) => value.turnMessageId === turnMessageId && !value.released,
      ) ?? null
    );
  }

  open(
    turnMessageId: string,
    toolCallId: string,
    input: QuestionRequest,
  ): Promise<QuestionCheckpoint> {
    return this.serialize(async () => {
      requiredString(turnMessageId);
      requiredString(toolCallId);
      const request = requestValue(input);
      const values = reduce(await this.log.read());
      const previous = [...values.values()].find(
        (value) => value.turnMessageId === turnMessageId && value.toolCallId === toolCallId,
      );
      if (previous) {
        if (
          previous.released ||
          !isDeepStrictEqual({ ...previous.request, id: request.id }, request)
        )
          throw new Error('conflicting question checkpoint');
        return previous;
      }
      if (values.has(request.id)) throw new Error('conflicting question checkpoint identity');
      if (
        [...values.values()].some(
          (value) => value.turnMessageId === turnMessageId && !value.released,
        )
      )
        throw new Error('another question checkpoint is active');
      await this.append({ type: 'opened', turnMessageId, toolCallId, request });
      return { turnMessageId, toolCallId, request, resolution: null, released: false };
    });
  }

  resolve(requestId: string, input: QuestionResolution): Promise<void> {
    return this.serialize(async () => {
      const checkpoint = reduce(await this.log.read()).get(requestId);
      if (!checkpoint) throw new Error('unknown question checkpoint');
      const resolution = resolutionValue(checkpoint.request, input);
      if (checkpoint.resolution) {
        if (!isDeepStrictEqual(checkpoint.resolution, resolution))
          throw new Error('conflicting question resolution');
        return;
      }
      await this.append({ type: 'resolved', requestId, resolution });
    });
  }

  release(requestId: string): Promise<void> {
    return this.serialize(async () => {
      const checkpoint = reduce(await this.log.read()).get(requestId);
      if (!checkpoint) throw new Error('unknown question checkpoint');
      if (!checkpoint.resolution)
        throw new Error('cannot release an unresolved question checkpoint');
      if (checkpoint.released) return;
      await this.append({ type: 'released', requestId });
    });
  }

  private append(record: Record<string, unknown>): Promise<void> {
    return this.log.append(
      { kind: 'journal', stream: QUESTION_CHECKPOINT_STREAM, record },
      {
        idempotencyKey: sessionLogAppendId(
          `${QUESTION_CHECKPOINT_STREAM}\0${JSON.stringify(record)}`,
        ),
      },
    );
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}
