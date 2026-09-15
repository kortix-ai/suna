import { isDeepStrictEqual } from 'node:util';
import type { PermissionRequest } from '@opencode-ai/sdk/v2';
import type { PermissionReply } from './permission-broker.ts';
import type { SessionLog, SessionLogItem } from './session-store.ts';
import { sessionLogAppendId } from './session-log-id.ts';

export const PERMISSION_CHECKPOINT_STREAM = 'kortix.pi.permission-checkpoints.v1';
export type PermissionStage = 'primary' | 'external_directory' | 'doom_loop';
export interface PermissionResolution {
  reply: PermissionReply;
  message?: string;
}
export interface PermissionCheckpoint {
  turnMessageId: string;
  toolCallId: string;
  stage: PermissionStage;
  request: PermissionRequest;
  resolution: PermissionResolution | null;
  released: boolean;
}

function requiredString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('invalid permission checkpoint identity');
}

function requestValue(value: unknown): PermissionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid permission checkpoint request');
  const request = structuredClone(value) as PermissionRequest;
  for (const value of [
    request.id,
    request.sessionID,
    request.permission,
    request.tool?.messageID,
    request.tool?.callID,
  ])
    requiredString(value);
  if (
    !Array.isArray(request.patterns) ||
    request.patterns.length === 0 ||
    !Array.isArray(request.always)
  )
    throw new Error('invalid permission checkpoint patterns');
  for (const value of [...request.patterns, ...request.always]) requiredString(value);
  if (!request.metadata || typeof request.metadata !== 'object' || Array.isArray(request.metadata))
    throw new Error('invalid permission checkpoint metadata');
  return request;
}

function resolutionValue(value: unknown): PermissionResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid permission resolution');
  const resolution = value as Record<string, unknown>;
  if (
    !['once', 'always', 'reject'].includes(String(resolution.reply)) ||
    Object.keys(resolution).some((key) => !['reply', 'message'].includes(key)) ||
    (resolution.message !== undefined &&
      (resolution.reply !== 'reject' || typeof resolution.message !== 'string'))
  )
    throw new Error('invalid permission resolution');
  return structuredClone(resolution) as unknown as PermissionResolution;
}

function sameTool(left: PermissionCheckpoint, right: PermissionCheckpoint): boolean {
  return (
    left.turnMessageId === right.turnMessageId &&
    left.toolCallId === right.toolCallId &&
    isDeepStrictEqual(left.request.tool, right.request.tool)
  );
}

function addOpened(values: Map<string, PermissionCheckpoint>, candidate: PermissionCheckpoint) {
  const previous = values.get(candidate.request.id);
  if (previous) {
    if (!isDeepStrictEqual({ ...previous, resolution: null, released: false }, candidate))
      throw new Error('conflicting permission checkpoint');
    return;
  }
  const active = [...values.values()].filter(
    (value) => value.turnMessageId === candidate.turnMessageId && !value.released,
  );
  if (active.some((value) => !sameTool(value, candidate)))
    throw new Error('another permission tool boundary is active');
  if (active.some((value) => value.stage === candidate.stage))
    throw new Error('conflicting permission checkpoint stage');
  if (active.some((value) => !value.resolution || value.resolution.reply === 'reject'))
    throw new Error('cannot advance an unresolved or rejected permission');
  values.set(candidate.request.id, candidate);
}

function releaseValues(values: Map<string, PermissionCheckpoint>, ids: unknown) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length)
    throw new Error('invalid permission release');
  const checkpoints = ids.map((id) => {
    requiredString(id);
    const checkpoint = values.get(id);
    if (!checkpoint) throw new Error('unknown permission checkpoint');
    if (!checkpoint.resolution) throw new Error('cannot release an unresolved permission');
    return checkpoint;
  });
  const first = checkpoints[0]!;
  if (
    checkpoints.some((value) => !sameTool(value, first)) ||
    [...values.values()].some(
      (value) => sameTool(value, first) && !value.released && !ids.includes(value.request.id),
    )
  )
    throw new Error('incomplete permission release');
  for (const checkpoint of checkpoints) checkpoint.released = true;
}

function reduce(items: readonly SessionLogItem[]): Map<string, PermissionCheckpoint> {
  const values = new Map<string, PermissionCheckpoint>();
  for (const item of items) {
    if (item.kind !== 'journal' || item.stream !== PERMISSION_CHECKPOINT_STREAM) continue;
    const record = item.record;
    if (record.type === 'opened') {
      requiredString(record.turnMessageId);
      requiredString(record.toolCallId);
      if (!['primary', 'external_directory', 'doom_loop'].includes(String(record.stage)))
        throw new Error('invalid permission checkpoint stage');
      addOpened(values, {
        turnMessageId: record.turnMessageId,
        toolCallId: record.toolCallId,
        stage: record.stage as PermissionStage,
        request: requestValue(record.request),
        resolution: null,
        released: false,
      });
    } else if (record.type === 'resolved') {
      requiredString(record.requestId);
      const checkpoint = values.get(record.requestId);
      if (!checkpoint) throw new Error('unknown permission checkpoint');
      const resolution = resolutionValue(record.resolution);
      if (checkpoint.resolution && !isDeepStrictEqual(checkpoint.resolution, resolution))
        throw new Error('conflicting permission resolution');
      checkpoint.resolution = resolution;
    } else if (record.type === 'released') {
      releaseValues(values, record.requestIds);
    } else {
      throw new Error('invalid permission checkpoint transition');
    }
  }
  return values;
}

export class PermissionCheckpointStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly log: SessionLog) {}

  async active(turnMessageId: string): Promise<PermissionCheckpoint[]> {
    return [...reduce(await this.log.read()).values()].filter(
      (value) => value.turnMessageId === turnMessageId && !value.released,
    );
  }

  open(
    turnMessageId: string,
    toolCallId: string,
    stage: PermissionStage,
    input: PermissionRequest,
  ): Promise<PermissionCheckpoint> {
    return this.serialize(async () => {
      requiredString(turnMessageId);
      requiredString(toolCallId);
      if (!['primary', 'external_directory', 'doom_loop'].includes(stage))
        throw new Error('invalid permission checkpoint stage');
      const request = requestValue(input);
      const candidate: PermissionCheckpoint = {
        turnMessageId,
        toolCallId,
        stage,
        request,
        resolution: null,
        released: false,
      };
      const values = reduce(await this.log.read());
      const previous = [...values.values()].find(
        (value) => sameTool(value, candidate) && value.stage === stage,
      );
      if (previous) {
        if (previous.released)
          throw new Error('permission execution boundary was already released');
        if (!isDeepStrictEqual({ ...previous.request, id: request.id }, request))
          throw new Error('conflicting permission checkpoint');
        return previous;
      }
      addOpened(values, candidate);
      await this.append({ type: 'opened', turnMessageId, toolCallId, stage, request });
      return candidate;
    });
  }

  resolve(requestId: string, input: PermissionResolution): Promise<void> {
    return this.serialize(async () => {
      const checkpoint = reduce(await this.log.read()).get(requestId);
      if (!checkpoint) throw new Error('unknown permission checkpoint');
      const resolution = resolutionValue(input);
      if (checkpoint.resolution) {
        if (!isDeepStrictEqual(checkpoint.resolution, resolution))
          throw new Error('conflicting permission resolution');
        return;
      }
      await this.append({ type: 'resolved', requestId, resolution });
    });
  }

  release(
    turnMessageId: string,
    toolCallId: string,
    tool: PermissionRequest['tool'],
  ): Promise<void> {
    return this.serialize(async () => {
      const values = reduce(await this.log.read());
      const requestIds = [...values.values()]
        .filter(
          (value) =>
            value.turnMessageId === turnMessageId &&
            value.toolCallId === toolCallId &&
            isDeepStrictEqual(value.request.tool, tool) &&
            !value.released,
        )
        .map((value) => value.request.id);
      if (!requestIds.length) return;
      releaseValues(values, requestIds);
      await this.append({ type: 'released', requestIds });
    });
  }

  private append(record: Record<string, unknown>): Promise<void> {
    return this.log.append(
      { kind: 'journal', stream: PERMISSION_CHECKPOINT_STREAM, record },
      {
        idempotencyKey: sessionLogAppendId(
          `${PERMISSION_CHECKPOINT_STREAM}\0${JSON.stringify(record)}`,
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
