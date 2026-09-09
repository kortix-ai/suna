import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sessionLogAppendId } from './session-log-id.ts';

import {
  type JournalLogItem,
  type SessionLog,
  SessionLogConflictError,
  SessionLogReadUnavailableError,
  SessionLogUnavailableError,
  type SessionLogItem,
  type StorageLogItem,
} from './session-store.ts';

/**
 * Durable admission is intentionally separate from Pi's durable message tree.
 * An accepted record commits before the HTTP caller can receive 204. A started
 * record commits before the turn crosses the model boundary. Replay returns
 * only accepted turns that never reached that boundary.
 *
 * This journal guarantees durable admission and at-most-once model execution.
 * A process can die after `started` commits and before a response completes.
 * A replacement claims the expired owner lease and records either the durable
 * terminal assistant or one interruption. It never reruns the model or an
 * unknown tool boundary. Exact wire envelopes survive safe pre-start replay, so
 * message ids and parent ids do not change. Exact duplicate records reduce to
 * one transition. Conflicting records fail closed instead of guessing which
 * conversation state is true.
 */
export const TURN_JOURNAL_STREAM = 'kortix.pi.turn-admission.v1';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface WireMessageEnvelope {
  info: JsonObject & { id: string; role: string };
  parts: JsonObject[];
}

export interface TurnAdmission {
  messageId: string;
  text: string;
  options: JsonObject;
  wireUserMessage: WireMessageEnvelope;
}

export type TurnJournalState = 'pending' | 'started' | 'cancelled' | 'completed' | 'missing';

export interface TurnJournalSnapshot {
  pending: TurnAdmission[];
  started: TurnAdmission[];
  wireMessages: WireMessageEnvelope[];
  unrelayed: Array<{ messageId: string; status: 'idle' | 'error' }>;
  states: Record<string, Exclude<TurnJournalState, 'missing'>>;
}

type TurnJournalEvent =
  | { type: 'accepted'; turn: TurnAdmission }
  | { type: 'started'; messageId: string; ownerId?: string; leaseVersion?: 1 }
  | { type: 'heartbeat'; messageId: string; ownerId: string }
  | {
      type: 'transcript';
      messageId: string;
      ownerId: string;
      previousRevision: number;
    }
  | {
      type: 'abort_requested';
      messageId: string;
      previousOwnerId: string | null;
      previousRevision: number;
    }
  | {
      type: 'abort_acknowledged';
      messageId: string;
      ownerId: string;
      previousRevision: number;
    }
  | {
      type: 'reclaimed';
      messageId: string;
      previousOwnerId: string | null;
      previousRevision: number;
      ownerId: string;
      leaseVersion: 1;
    }
  | { type: 'cancelled'; messageId: string }
  | {
      type: 'assistant';
      messageId: string;
      assistantWireMessage: WireMessageEnvelope;
      ownerId?: string;
    }
  | {
      type: 'completed';
      messageId: string;
      /** Present on logs written before assistant metadata became one item per message. */
      assistantWireMessages?: WireMessageEnvelope[];
      status?: 'idle' | 'error';
      ownerId?: string;
    }
  | { type: 'relayed'; messageId: string };

interface ReducedTurn {
  admission: TurnAdmission;
  state: Exclude<TurnJournalState, 'missing'>;
  assistantWireMessages: WireMessageEnvelope[];
  relayStatus: 'idle' | 'error' | null;
  relayed: boolean;
  ownerId: string | null;
  leaseRevision: number;
  abortRequested: boolean;
  abortAcknowledged: boolean;
}

export interface TurnOwnerLease {
  ownerId: string | null;
  revision: number;
}

interface OrderedWireMessage {
  turnMessageId: string;
  message: WireMessageEnvelope;
}

interface ReducedJournal {
  order: string[];
  turns: Map<string, ReducedTurn>;
  wireOrder: OrderedWireMessage[];
  wireById: Map<string, WireMessageEnvelope>;
  wireFloorId: string | null;
}

export class TurnJournalCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TurnJournalCorruptionError';
  }
}

export class TurnJournalMessageOrderError extends Error {
  constructor() {
    super('messageID must sort after the durable transcript');
    this.name = 'TurnJournalMessageOrderError';
  }
}

export class TurnJournalAdmissionConflictError extends Error {
  constructor(messageId: string, options?: ErrorOptions) {
    super(`turn ${messageId} has conflicting accepted payloads`, options);
    this.name = 'TurnJournalAdmissionConflictError';
  }
}

function newestWireMessageId(reduced: ReducedJournal): string | null {
  return reduced.wireFloorId;
}

function cloneJsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError(`${label} must be JSON serializable`, { cause });
  }
  const clone = JSON.parse(encoded) as JsonObject;
  if (!isDeepStrictEqual(value, clone)) {
    throw new TypeError(`${label} must contain only JSON values`);
  }
  return clone;
}

function normalizeWireMessage(
  value: unknown,
  role: 'user' | 'assistant',
  expectedId?: string,
): WireMessageEnvelope {
  const envelope = cloneJsonObject(value, `wire ${role} message`);
  const info = envelope.info;
  const parts = envelope.parts;
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    throw new TypeError(`wire ${role} message info must be a JSON object`);
  }
  if (typeof info.id !== 'string' || info.id.length === 0) {
    throw new TypeError(`wire ${role} message id must be a non-empty string`);
  }
  if (info.role !== role) {
    throw new TypeError(`wire ${role} message role must equal ${role}`);
  }
  if (expectedId !== undefined && info.id !== expectedId) {
    throw new TypeError('wire user message id must equal turn message id');
  }
  if (
    !Array.isArray(parts) ||
    parts.some((part) => !part || typeof part !== 'object' || Array.isArray(part))
  ) {
    throw new TypeError(`wire ${role} message parts must be JSON objects`);
  }
  for (const part of parts as JsonObject[]) {
    if ('messageID' in part && part.messageID !== info.id) {
      throw new TypeError(`wire ${role} message part must reference its message id`);
    }
  }
  return envelope as unknown as WireMessageEnvelope;
}

function normalizeAdmission(value: unknown): TurnAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('turn admission must be an object');
  }
  const candidate = value as Partial<TurnAdmission>;
  if (typeof candidate.messageId !== 'string' || candidate.messageId.length === 0) {
    throw new TypeError('turn message id must be a non-empty string');
  }
  if (typeof candidate.text !== 'string') {
    throw new TypeError('turn text must be a string');
  }
  return {
    messageId: candidate.messageId,
    text: candidate.text,
    options: cloneJsonObject(candidate.options, 'turn options'),
    wireUserMessage: normalizeWireMessage(candidate.wireUserMessage, 'user', candidate.messageId),
  };
}

/**
 * Two workers reconstruct the same accepted request at different wall times.
 * The creation timestamp is presentation metadata, not turn identity.
 */
function isSameAdmissionInput(left: TurnAdmission, right: TurnAdmission): boolean {
  const withoutCreatedAt = (turn: TurnAdmission): TurnAdmission => {
    const clone = structuredClone(turn);
    if (clone.wireUserMessage.info.time && typeof clone.wireUserMessage.info.time === 'object') {
      Reflect.deleteProperty(clone.wireUserMessage.info.time as JsonObject, 'created');
    }
    return clone;
  };
  return isDeepStrictEqual(withoutCreatedAt(left), withoutCreatedAt(right));
}

function normalizeAssistantMessages(value: unknown): WireMessageEnvelope[] {
  if (!Array.isArray(value)) {
    throw new TypeError('assistant wire messages must be an array');
  }
  return value.map((message) => normalizeWireMessage(message, 'assistant'));
}

function messageId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('turn message id must be a non-empty string');
  }
  return value;
}

function ownerId(value: unknown): string;
function ownerId(value: unknown, optional: true): string | undefined;
function ownerId(value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('turn owner id must be a non-empty string');
  }
  return value;
}

function decodeEvent(item: SessionLogItem): TurnJournalEvent | null {
  if (item.kind !== 'journal' || item.stream !== TURN_JOURNAL_STREAM) return null;
  try {
    const record = item.record;
    switch (record.type) {
      case 'accepted':
        return { type: 'accepted', turn: normalizeAdmission(record.turn) };
      case 'cancelled':
        return { type: 'cancelled', messageId: messageId(record.messageId) };
      case 'started': {
        if (record.leaseVersion !== undefined && record.leaseVersion !== 1) {
          throw new TypeError('turn lease version is invalid');
        }
        return {
          type: 'started',
          messageId: messageId(record.messageId),
          ownerId: ownerId(record.ownerId, true),
          leaseVersion: record.leaseVersion as 1 | undefined,
        };
      }
      case 'heartbeat':
        return {
          type: 'heartbeat',
          messageId: messageId(record.messageId),
          ownerId: ownerId(record.ownerId),
        };
      case 'abort_requested': {
        if (
          (record.previousOwnerId !== null && typeof record.previousOwnerId !== 'string') ||
          !Number.isSafeInteger(record.previousRevision) ||
          Number(record.previousRevision) < 0
        ) {
          throw new TypeError('abort request lease is invalid');
        }
        return {
          type: 'abort_requested',
          messageId: messageId(record.messageId),
          previousOwnerId: record.previousOwnerId as string | null,
          previousRevision: Number(record.previousRevision),
        };
      }
      case 'abort_acknowledged': {
        if (!Number.isSafeInteger(record.previousRevision) || Number(record.previousRevision) < 0) {
          throw new TypeError('abort acknowledgement lease is invalid');
        }
        return {
          type: 'abort_acknowledged',
          messageId: messageId(record.messageId),
          ownerId: ownerId(record.ownerId),
          previousRevision: Number(record.previousRevision),
        };
      }
      case 'reclaimed': {
        if (
          (record.previousOwnerId !== null && typeof record.previousOwnerId !== 'string') ||
          !Number.isSafeInteger(record.previousRevision) ||
          Number(record.previousRevision) < 0 ||
          record.leaseVersion !== 1
        ) {
          throw new TypeError('reclaimed turn lease is invalid');
        }
        return {
          type: 'reclaimed',
          messageId: messageId(record.messageId),
          previousOwnerId: record.previousOwnerId as string | null,
          previousRevision: Number(record.previousRevision),
          ownerId: ownerId(record.ownerId),
          leaseVersion: 1,
        };
      }
      case 'assistant':
        return {
          type: 'assistant',
          messageId: messageId(record.messageId),
          assistantWireMessage: normalizeWireMessage(record.assistantWireMessage, 'assistant'),
          ownerId: ownerId(record.ownerId, true),
        };
      case 'completed': {
        if (record.status !== undefined && record.status !== 'idle' && record.status !== 'error') {
          throw new TypeError('completed turn status is invalid');
        }
        return {
          type: 'completed',
          messageId: messageId(record.messageId),
          assistantWireMessages:
            record.assistantWireMessages === undefined
              ? undefined
              : normalizeAssistantMessages(record.assistantWireMessages),
          status: record.status,
          ownerId: ownerId(record.ownerId, true),
        };
      }
      case 'relayed':
        return { type: 'relayed', messageId: messageId(record.messageId) };
      default:
        throw new TypeError('turn journal event type is invalid');
    }
  } catch (cause) {
    throw new TurnJournalCorruptionError('persisted turn journal record is invalid', { cause });
  }
}

function decodeTranscriptEvent(item: SessionLogItem): TurnJournalEvent | null {
  if (item._kortixTurnLease === undefined) return null;
  if (item.kind === 'journal' && item.stream === TURN_JOURNAL_STREAM) {
    throw new TurnJournalCorruptionError('turn journal transitions cannot carry transcript fences');
  }
  try {
    const lease = item._kortixTurnLease;
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
      throw new TypeError('transcript lease must be an object');
    }
    if (lease.stream !== TURN_JOURNAL_STREAM) return null;
    if (!Number.isSafeInteger(lease.previousRevision) || lease.previousRevision < 0) {
      throw new TypeError('transcript lease revision is invalid');
    }
    return {
      type: 'transcript',
      messageId: messageId(lease.messageId),
      ownerId: ownerId(lease.ownerId),
      previousRevision: lease.previousRevision,
    };
  } catch (cause) {
    throw new TurnJournalCorruptionError('persisted transcript lease is invalid', { cause });
  }
}

function emptyJournal(): ReducedJournal {
  return {
    order: [],
    turns: new Map(),
    wireOrder: [],
    wireById: new Map(),
    wireFloorId: null,
  };
}

function observeWireFloor(reduced: ReducedJournal, id: unknown): void {
  if (typeof id !== 'string' || id.length === 0) return;
  if (reduced.wireFloorId === null || id > reduced.wireFloorId) reduced.wireFloorId = id;
}

function appendWireMessage(
  reduced: ReducedJournal,
  turnMessageId: string,
  message: WireMessageEnvelope,
): void {
  const id = message.info.id;
  const existing = reduced.wireById.get(id);
  if (existing) {
    if (isDeepStrictEqual(existing, message)) return;
    throw new TurnJournalCorruptionError(`wire message ${id} has conflicting persisted content`);
  }
  reduced.wireById.set(id, message);
  reduced.wireOrder.push({ turnMessageId, message });
  observeWireFloor(reduced, id);
}

function applyEvent(reduced: ReducedJournal, event: TurnJournalEvent): void {
  if (event.type === 'accepted') {
    const existing = reduced.turns.get(event.turn.messageId);
    if (existing) {
      if (isDeepStrictEqual(existing.admission, event.turn)) return;
      throw new TurnJournalCorruptionError(
        `turn ${event.turn.messageId} has conflicting accepted payloads`,
      );
    }
    reduced.order.push(event.turn.messageId);
    reduced.turns.set(event.turn.messageId, {
      admission: event.turn,
      state: 'pending',
      assistantWireMessages: [],
      relayStatus: null,
      relayed: false,
      ownerId: null,
      leaseRevision: 0,
      abortRequested: false,
      abortAcknowledged: false,
    });
    appendWireMessage(reduced, event.turn.messageId, event.turn.wireUserMessage);
    return;
  }

  const turn = reduced.turns.get(event.messageId);
  if (!turn) {
    throw new TurnJournalCorruptionError(
      `turn ${event.messageId} reached ${event.type} before acceptance`,
    );
  }
  if (event.type === 'started') {
    if (turn.state === 'started') {
      if (turn.ownerId === (event.leaseVersion === 1 ? (event.ownerId ?? null) : null)) return;
      throw new TurnJournalCorruptionError(`turn ${event.messageId} has conflicting owners`);
    }
    if (turn.state !== 'pending') {
      throw new TurnJournalCorruptionError(`turn ${event.messageId} started after ${turn.state}`);
    }
    turn.state = 'started';
    turn.ownerId = event.leaseVersion === 1 ? (event.ownerId ?? null) : null;
    turn.leaseRevision = turn.ownerId ? 1 : 0;
    return;
  }
  if (event.type === 'heartbeat') {
    if (turn.state !== 'started' || turn.ownerId !== event.ownerId) {
      throw new TurnJournalCorruptionError(
        `turn ${event.messageId} heartbeat came from a stale owner`,
      );
    }
    turn.leaseRevision += 1;
    return;
  }
  if (event.type === 'transcript') {
    if (
      turn.state !== 'started' ||
      turn.ownerId !== event.ownerId ||
      turn.leaseRevision !== event.previousRevision
    ) {
      throw new TurnJournalCorruptionError(
        `turn ${event.messageId} persisted transcript from a stale owner`,
      );
    }
    turn.leaseRevision += 1;
    return;
  }
  if (event.type === 'reclaimed') {
    if (
      turn.state !== 'started' ||
      turn.ownerId !== event.previousOwnerId ||
      turn.leaseRevision !== event.previousRevision
    ) {
      throw new TurnJournalCorruptionError(`turn ${event.messageId} reclaimed a changed lease`);
    }
    turn.ownerId = event.ownerId;
    turn.leaseRevision += 1;
    return;
  }
  if (event.type === 'abort_requested') {
    if (
      turn.state !== 'started' ||
      turn.ownerId !== event.previousOwnerId ||
      turn.leaseRevision !== event.previousRevision
    ) {
      throw new TurnJournalCorruptionError(
        `turn ${event.messageId} requested abort against a changed lease`,
      );
    }
    turn.abortRequested = true;
    turn.leaseRevision += 1;
    return;
  }
  if (event.type === 'abort_acknowledged') {
    if (
      turn.state !== 'started' ||
      turn.ownerId !== event.ownerId ||
      turn.leaseRevision !== event.previousRevision ||
      !turn.abortRequested
    ) {
      throw new TurnJournalCorruptionError(
        `turn ${event.messageId} acknowledged abort against a changed lease`,
      );
    }
    turn.abortAcknowledged = true;
    turn.leaseRevision += 1;
    return;
  }
  if (event.type === 'cancelled') {
    if (turn.state === 'cancelled') return;
    if (turn.state === 'completed' || turn.state === 'started') {
      throw new TurnJournalCorruptionError(
        `turn ${event.messageId} was cancelled after ${turn.state}`,
      );
    }
    turn.state = 'cancelled';
    return;
  }
  if (event.type === 'assistant') {
    if (turn.state === 'cancelled' || turn.state === 'completed') {
      throw new TurnJournalCorruptionError(
        `turn ${event.messageId} recorded assistant metadata after ${turn.state}`,
      );
    }
    if (turn.state === 'started' && turn.ownerId && event.ownerId !== turn.ownerId) {
      throw new TurnJournalCorruptionError(
        `turn ${event.messageId} recorded assistant metadata from a stale owner`,
      );
    }
    const existing = turn.assistantWireMessages.find(
      (message) => message.info.id === event.assistantWireMessage.info.id,
    );
    if (existing) {
      if (isDeepStrictEqual(existing, event.assistantWireMessage)) return;
      throw new TurnJournalCorruptionError(
        `assistant message ${event.assistantWireMessage.info.id} has conflicting metadata`,
      );
    }
    turn.assistantWireMessages.push(event.assistantWireMessage);
    appendWireMessage(reduced, event.messageId, event.assistantWireMessage);
    return;
  }
  if (event.type === 'relayed') {
    if (turn.state !== 'completed' || turn.relayStatus === null) {
      throw new TurnJournalCorruptionError(
        `turn ${event.messageId} was relayed before durable completion`,
      );
    }
    turn.relayed = true;
    return;
  }
  if (turn.state === 'completed') {
    const duplicateStatus = event.status ?? turn.relayStatus;
    if (
      (!event.assistantWireMessages ||
        isDeepStrictEqual(turn.assistantWireMessages, event.assistantWireMessages)) &&
      duplicateStatus === turn.relayStatus
    ) {
      return;
    }
    throw new TurnJournalCorruptionError(
      `turn ${event.messageId} has conflicting completion payloads`,
    );
  }
  if (turn.state === 'cancelled') {
    throw new TurnJournalCorruptionError(`turn ${event.messageId} completed after cancellation`);
  }
  if (turn.state === 'started' && turn.ownerId && event.ownerId !== turn.ownerId) {
    throw new TurnJournalCorruptionError(`turn ${event.messageId} completed from a stale owner`);
  }
  for (const message of event.assistantWireMessages ?? []) {
    const existing = turn.assistantWireMessages.find(
      (candidate) => candidate.info.id === message.info.id,
    );
    if (existing) {
      if (!isDeepStrictEqual(existing, message)) {
        throw new TurnJournalCorruptionError(
          `assistant message ${message.info.id} has conflicting persisted content`,
        );
      }
      continue;
    }
    turn.assistantWireMessages.push(message);
    appendWireMessage(reduced, event.messageId, message);
  }
  turn.state = 'completed';
  turn.relayStatus =
    event.status ??
    (turn.assistantWireMessages.some((message) => Boolean(message.info.error)) ? 'error' : 'idle');
}

function reduceItems(items: readonly SessionLogItem[]): ReducedJournal {
  const reduced = emptyJournal();
  for (const item of items) {
    const transcriptEvent = decodeTranscriptEvent(item);
    if (transcriptEvent) applyEvent(reduced, transcriptEvent);
    if (item.kind === 'entry' && item.entry?.type === 'message') {
      observeWireFloor(reduced, item.entry.message?.kortixWireMessageId);
    }
    const event = decodeEvent(item);
    if (event) applyEvent(reduced, event);
  }
  return reduced;
}

function snapshot(reduced: ReducedJournal): TurnJournalSnapshot {
  const pending: TurnAdmission[] = [];
  const started: TurnAdmission[] = [];
  const unrelayed: TurnJournalSnapshot['unrelayed'] = [];
  const states: TurnJournalSnapshot['states'] = {};
  for (const id of reduced.order) {
    const turn = reduced.turns.get(id);
    if (!turn) {
      throw new TurnJournalCorruptionError(`turn ${id} is missing from reduced state`);
    }
    states[id] = turn.state;
    if (turn.state === 'pending') pending.push(structuredClone(turn.admission));
    if (turn.state === 'started') started.push(structuredClone(turn.admission));
    if (turn.state === 'completed' && turn.relayStatus && !turn.relayed) {
      unrelayed.push({ messageId: id, status: turn.relayStatus });
    }
  }
  const wireMessages = reduced.wireOrder
    .filter(({ turnMessageId }) => reduced.turns.get(turnMessageId)?.state !== 'cancelled')
    .map(({ message }) => structuredClone(message));
  return { pending, started, wireMessages, unrelayed, states };
}

function itemFor(event: TurnJournalEvent): JournalLogItem {
  return {
    kind: 'journal',
    stream: TURN_JOURNAL_STREAM,
    record: event,
  };
}

export function reduceTurnJournal(items: readonly SessionLogItem[]): TurnJournalSnapshot {
  return snapshot(reduceItems(items));
}

export class TurnAdmissionJournal {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly ownerId = randomUUID();

  private constructor(
    private readonly log: SessionLog,
    private reduced: ReducedJournal,
  ) {}

  static async open(log: SessionLog): Promise<TurnAdmissionJournal> {
    return TurnAdmissionJournal.fromItems(log, await log.read());
  }

  static fromItems(log: SessionLog, items: readonly SessionLogItem[]): TurnAdmissionJournal {
    return new TurnAdmissionJournal(log, reduceItems(items));
  }

  get pending(): TurnAdmission[] {
    return snapshot(this.reduced).pending;
  }

  get started(): TurnAdmission[] {
    return snapshot(this.reduced).started;
  }

  get wireMessages(): WireMessageEnvelope[] {
    return snapshot(this.reduced).wireMessages;
  }

  get unrelayed(): Array<{ messageId: string; status: 'idle' | 'error' }> {
    return snapshot(this.reduced).unrelayed;
  }

  get toolControls(): Record<string, boolean> {
    for (let index = this.reduced.order.length - 1; index >= 0; index--) {
      const turn = this.reduced.turns.get(this.reduced.order[index]!);
      if (!turn || (turn.state !== 'started' && turn.state !== 'completed')) continue;
      const tools = turn.admission.options.tools;
      if (tools === undefined) continue;
      if (
        !tools || typeof tools !== 'object' || Array.isArray(tools) ||
        Object.entries(tools).some(
          ([name, enabled]) => !name.trim() || typeof enabled !== 'boolean',
        )
      ) {
        throw new TurnJournalCorruptionError(
          'durable tool controls must map permission names to booleans',
        );
      }
      if (Object.keys(tools).length > 0) {
        return structuredClone(tools) as Record<string, boolean>;
      }
    }
    return {};
  }

  state(messageId: string): TurnJournalState {
    return this.reduced.turns.get(messageId)?.state ?? 'missing';
  }

  completionStatus(messageId: string): 'idle' | 'error' | null {
    const turn = this.reduced.turns.get(messageId);
    return turn?.state === 'completed' ? turn.relayStatus : null;
  }

  admission(messageId: string): TurnAdmission | null {
    const turn = this.reduced.turns.get(messageId);
    return turn ? structuredClone(turn.admission) : null;
  }

  startedLease(messageId: string): TurnOwnerLease | null {
    const turn = this.reduced.turns.get(messageId);
    if (!turn || turn.state !== 'started') return null;
    return { ownerId: turn.ownerId, revision: turn.leaseRevision };
  }

  turnOwnerId(messageId: string): string | null {
    return this.reduced.turns.get(messageId)?.ownerId ?? null;
  }

  abortRequested(messageId: string): boolean {
    return this.reduced.turns.get(messageId)?.abortRequested ?? false;
  }

  abortAcknowledged(messageId: string): boolean {
    return this.reduced.turns.get(messageId)?.abortAcknowledged ?? false;
  }

  oldestNonterminal(): { messageId: string; state: 'pending' | 'started' } | null {
    for (const id of this.reduced.order) {
      const state = this.reduced.turns.get(id)?.state;
      if (state === 'pending' || state === 'started') return { messageId: id, state };
    }
    return null;
  }

  accept(turn: TurnAdmission): Promise<boolean> {
    return this.serialize(async () => {
      const normalized = normalizeAdmission(turn);
      while (true) {
        await this.reload();
        const existing = this.reduced.turns.get(normalized.messageId);
        if (existing) {
          if (!isSameAdmissionInput(existing.admission, normalized)) {
            throw new TurnJournalAdmissionConflictError(normalized.messageId);
          }
          return false;
        }

        const floor = newestWireMessageId(this.reduced);
        if (floor !== null && normalized.messageId <= floor) {
          throw new TurnJournalMessageOrderError();
        }
        const event: TurnJournalEvent = { type: 'accepted', turn: normalized };
        this.log.preflight?.(itemFor(event));
        try {
          // This is a compare-and-append chain. Two workers that observed the
          // same floor compete for one deterministic fence. The loser reloads
          // the new floor and validates again, so distinct message ids cannot
          // commit in an order that the lexicographic transcript would invert.
          await this.appendEvent(event, journalFenceId('accept-floor', floor ?? 'root'));
          return true;
        } catch (error) {
          if (!(error instanceof SessionLogConflictError)) throw error;
          await this.reload();
          const persisted = this.reduced.turns.get(normalized.messageId);
          if (persisted) {
            if (isSameAdmissionInput(persisted.admission, normalized)) return false;
            throw new TurnJournalAdmissionConflictError(normalized.messageId, { cause: error });
          }
          // A distinct acceptance won this floor. Loop and compare against it.
        }
      }
    });
  }

  cancel(messageId: string): Promise<boolean> {
    return this.serialize(async () => {
      const id = messageId.trim();
      await this.reload();
      const turn = this.reduced.turns.get(id);
      if (!turn || turn.state !== 'pending') return false;
      const event: TurnJournalEvent = { type: 'cancelled', messageId: id };
      try {
        await this.appendEvent(event, journalFenceId('transition', id));
      } catch (error) {
        if (!(error instanceof SessionLogConflictError)) throw error;
        await this.reload();
        const persistedState = this.reduced.turns.get(id)?.state;
        if (
          persistedState === 'started' ||
          persistedState === 'cancelled' ||
          persistedState === 'completed'
        ) {
          return false;
        }
        throw new TurnJournalCorruptionError(`turn ${id} could not acquire the transition fence`, {
          cause: error,
        });
      }
      return true;
    });
  }

  start(messageId: string): Promise<boolean> {
    return this.serialize(async () => {
      const id = messageId.trim();
      // Every process owns a cache of the append-only journal. Refresh before
      // crossing the model boundary so two workers make the decision from the
      // same database-assigned acceptance order.
      await this.reload();
      const turn = this.reduced.turns.get(id);
      if (!turn || turn.state !== 'pending') return false;
      const durableHead = this.reduced.order.find((candidate) => {
        const state = this.reduced.turns.get(candidate)?.state;
        return state === 'pending' || state === 'started';
      });
      if (durableHead !== id) return false;
      const event: TurnJournalEvent = {
        type: 'started',
        messageId: id,
        ownerId: this.ownerId,
        leaseVersion: 1,
      };
      try {
        await this.appendEvent(event, journalFenceId('transition', id));
      } catch (error) {
        if (!(error instanceof SessionLogConflictError)) throw error;
        await this.reload();
        const persistedState = this.reduced.turns.get(id)?.state;
        if (
          persistedState === 'started' ||
          persistedState === 'cancelled' ||
          persistedState === 'completed'
        ) {
          return false;
        }
        throw new TurnJournalCorruptionError(`turn ${id} could not acquire the transition fence`, {
          cause: error,
        });
      }
      return true;
    });
  }

  heartbeat(messageId: string): Promise<boolean> {
    return this.serialize(async () => {
      const id = messageId.trim();
      const ownHeartbeat = (item: SessionLogItem) =>
        item.kind === 'journal' && item.stream === TURN_JOURNAL_STREAM &&
        item.record.type === 'heartbeat' && item.record.messageId === id &&
        item.record.ownerId === this.ownerId;
      let recovered = false;
      while (true) {
        await this.reload();
        const turn = this.reduced.turns.get(id);
        if (!turn || turn.state !== 'started' || turn.ownerId !== this.ownerId) return false;
        try {
          await this.appendEvent(
            { type: 'heartbeat', messageId: id, ownerId: this.ownerId },
            leaseFenceId(id, turn.ownerId, turn.leaseRevision),
          );
        } catch (error) {
          if (
            error instanceof SessionLogUnavailableError &&
            this.log.canRecoverPendingAppendsMatching?.(ownHeartbeat)
          ) {
            if (!recovered && await this.log.recoverPendingAppends?.(ownHeartbeat)) {
              recovered = true;
              // Recovery may confirm an old append. Renew only after a fresh
              // heartbeat proves ownership against the current lease revision.
              continue;
            }
            if (this.log.canRecoverPendingAppendsMatching?.(ownHeartbeat)) {
              throw new SessionLogReadUnavailableError(
                'turn heartbeat storage is temporarily unavailable', { cause: error },
              );
            }
          }
          if (!(error instanceof SessionLogConflictError)) throw error;
          await this.reload();
          const persisted = this.reduced.turns.get(id);
          // Abort request/acknowledgement can advance this owner's lease on the
          // same fence. Ownership remains valid; only a terminal transition or
          // a different owner fences this process out.
          return persisted?.state === 'started' && persisted.ownerId === this.ownerId;
        }
        return true;
      }
    });
  }

  appendTranscriptMutation(messageId: string, item: SessionLogItem): Promise<boolean> {
    return this.serialize(async () => {
      if (item.kind === 'journal' && item.stream === TURN_JOURNAL_STREAM) {
        throw new TypeError('turn journal transitions cannot be transcript mutations');
      }
      const id = messageId.trim();
      while (true) {
        await this.reload();
        const turn = this.reduced.turns.get(id);
        if (!turn || turn.state !== 'started' || turn.ownerId !== this.ownerId) return false;
        const transcriptEvent: TurnJournalEvent = {
          type: 'transcript',
          messageId: id,
          ownerId: this.ownerId,
          previousRevision: turn.leaseRevision,
        };
        const unfenced = structuredClone(item);
        Reflect.deleteProperty(unfenced, '_kortixTurnLease');
        const fenced: SessionLogItem = {
          ...unfenced,
          _kortixTurnLease: {
            stream: TURN_JOURNAL_STREAM,
            messageId: id,
            ownerId: this.ownerId,
            previousRevision: turn.leaseRevision,
          },
        };
        const next = structuredClone(this.reduced);
        applyEvent(next, transcriptEvent);
        try {
          await this.log.append(fenced, {
            idempotencyKey: leaseFenceId(id, turn.ownerId, turn.leaseRevision),
          });
          this.reduced = next;
          return true;
        } catch (error) {
          if (!(error instanceof SessionLogConflictError)) throw error;
          await this.reload();
          const persisted = this.reduced.turns.get(id);
          // A heartbeat or another transcript mutation from this owner can win
          // the same lease revision. Retry the unchanged storage item against
          // the advanced revision. A reclaim fences this process out.
          if (
            persisted?.state === 'started' &&
            persisted.ownerId === this.ownerId &&
            persisted.leaseRevision > turn.leaseRevision
          ) {
            continue;
          }
          return false;
        }
      }
    });
  }

  reclaim(messageId: string, observed: TurnOwnerLease): Promise<boolean> {
    return this.serialize(async () => {
      const id = messageId.trim();
      await this.reload();
      const turn = this.reduced.turns.get(id);
      if (
        !turn ||
        turn.state !== 'started' ||
        turn.ownerId !== observed.ownerId ||
        turn.leaseRevision !== observed.revision
      ) {
        return false;
      }
      const event: TurnJournalEvent = {
        type: 'reclaimed',
        messageId: id,
        previousOwnerId: observed.ownerId,
        previousRevision: observed.revision,
        ownerId: this.ownerId,
        leaseVersion: 1,
      };
      try {
        await this.appendEvent(event, leaseFenceId(id, observed.ownerId, observed.revision));
      } catch (error) {
        if (!(error instanceof SessionLogConflictError)) throw error;
        await this.reload();
        return false;
      }
      return true;
    });
  }

  requestAbort(messageId: string, options: { ownLeaseOnly?: boolean } = {}): Promise<boolean> {
    return this.serialize(async () => {
      const id = messageId.trim();
      while (true) {
        await this.reload();
        const turn = this.reduced.turns.get(id);
        if (!turn || turn.state !== 'started') return false;
        if (options.ownLeaseOnly && turn.ownerId !== this.ownerId) return false;
        if (turn.abortRequested) return true;
        const event: TurnJournalEvent = {
          type: 'abort_requested',
          messageId: id,
          previousOwnerId: turn.ownerId,
          previousRevision: turn.leaseRevision,
        };
        try {
          await this.appendEvent(event, leaseFenceId(id, turn.ownerId, turn.leaseRevision));
          return true;
        } catch (error) {
          if (!(error instanceof SessionLogConflictError)) throw error;
          await this.reload();
          const persisted = this.reduced.turns.get(id);
          if (persisted?.state !== 'started') return false;
          if (persisted.abortRequested) return true;
          // A heartbeat or reclaim advanced the lease first. Request abort
          // against the current owner instead of losing Stop at the race.
        }
      }
    });
  }

  acknowledgeAbort(messageId: string): Promise<boolean> {
    return this.serialize(async () => {
      const id = messageId.trim();
      while (true) {
        await this.reload();
        const turn = this.reduced.turns.get(id);
        if (
          !turn ||
          turn.state !== 'started' ||
          turn.ownerId !== this.ownerId ||
          !turn.abortRequested
        ) {
          return false;
        }
        if (turn.abortAcknowledged) return true;
        const event: TurnJournalEvent = {
          type: 'abort_acknowledged',
          messageId: id,
          ownerId: this.ownerId,
          previousRevision: turn.leaseRevision,
        };
        try {
          await this.appendEvent(event, leaseFenceId(id, turn.ownerId, turn.leaseRevision));
          return true;
        } catch (error) {
          if (!(error instanceof SessionLogConflictError)) throw error;
          await this.reload();
          const persisted = this.reduced.turns.get(id);
          if (persisted?.state !== 'started' || persisted.ownerId !== this.ownerId) return false;
          if (persisted.abortAcknowledged) return true;
        }
      }
    });
  }

  complete(
    messageId: string,
    assistantWireMessages: WireMessageEnvelope[] = [],
    status: 'idle' | 'error' = assistantWireMessages.some((message) => Boolean(message.info.error))
      ? 'error'
      : 'idle',
  ): Promise<boolean> {
    return this.serialize(async () => {
      const id = messageId.trim();
      const assistants = normalizeAssistantMessages(assistantWireMessages).map((message) => ({
        info: message.info,
        parts: [],
      }));
      while (true) {
        await this.reload();
        const turn = this.reduced.turns.get(id);
        if (!turn) return false;
        const completionStatus = turn.abortRequested ? 'error' : status;
        if (turn.state === 'completed') {
          return (
            turn.relayStatus === completionStatus &&
            isDeepStrictEqual(turn.assistantWireMessages, assistants)
          );
        }
        if (turn.state !== 'pending' && turn.state !== 'started') return false;
        if (turn.state === 'started' && turn.ownerId && turn.ownerId !== this.ownerId) return false;
        if (turn.state === 'started' && turn.abortRequested && !turn.abortAcknowledged)
          return false;
        const event: TurnJournalEvent = {
          type: 'completed',
          messageId: id,
          assistantWireMessages: assistants,
          status: completionStatus,
          ...(turn.ownerId ? { ownerId: this.ownerId } : {}),
        };
        const planned = structuredClone(this.reduced);
        applyEvent(planned, event);
        this.log.preflight?.(itemFor(event));
        const fence =
          turn.state === 'started'
            ? leaseFenceId(id, turn.ownerId, turn.leaseRevision)
            : journalFenceId('transition', id);
        try {
          await this.appendEvent(event, fence);
          return true;
        } catch (error) {
          if (!(error instanceof SessionLogConflictError)) throw error;
          await this.reload();
          const persisted = this.reduced.turns.get(id);
          // A heartbeat from this owner can advance the lease while completion
          // waits on storage. Retry against that new revision. A completion or
          // reclaim from another contender owns the terminal decision.
          if (
            persisted?.state === 'started' &&
            persisted.ownerId === this.ownerId &&
            persisted.leaseRevision > turn.leaseRevision
          ) {
            continue;
          }
          if (
            persisted?.state === 'completed' &&
            persisted.relayStatus === completionStatus &&
            isDeepStrictEqual(persisted.assistantWireMessages, assistants)
          ) {
            return true;
          }
          return false;
        }
      }
    });
  }

  markRelayed(messageId: string): Promise<boolean> {
    return this.serialize(async () => {
      const id = messageId.trim();
      const turn = this.reduced.turns.get(id);
      if (!turn || turn.state !== 'completed' || turn.relayStatus === null || turn.relayed) {
        return false;
      }
      await this.appendEvent({ type: 'relayed', messageId: id });
      return true;
    });
  }

  refresh(): Promise<TurnJournalSnapshot> {
    return this.serialize(async () => {
      await this.reload();
      return snapshot(this.reduced);
    });
  }

  private async appendEvent(event: TurnJournalEvent, idempotencyKey?: string): Promise<void> {
    const next = structuredClone(this.reduced);
    applyEvent(next, event);
    await this.log.append(itemFor(event), { idempotencyKey });
    this.reduced = next;
  }

  private async reload(): Promise<void> {
    this.reduced = reduceItems(await this.log.read());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function journalFenceId(type: 'accept-floor' | 'transition' | 'lease', messageId: string): string {
  return sessionLogAppendId(`${TURN_JOURNAL_STREAM}\0${type}\0${messageId}`);
}

function leaseFenceId(messageId: string, owner: string | null, revision: number): string {
  return journalFenceId('lease', `${messageId}:${owner ?? 'legacy'}:${revision}`);
}
