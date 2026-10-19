/**
 * Kortix app events (source `mcp`): what each event type asks a read-only MCP
 * tool, and how the answer becomes items. Pure: no DB, no network.
 *
 * Curated types are built on Google tools whose input and output schemas were
 * read from a live `tools/list` (2026-10-19). Any other read-only list or
 * search tool of an MCP connector is the generic `new_item.<tool>`.
 */
import { createHash } from 'node:crypto';
import type { EventTypeInfo } from './types';

export const INTERVAL_MINUTES = [1, 5, 15, 30, 60, 360, 1440] as const;
export const DEFAULT_INTERVAL_MINUTES = 5;
export const GENERIC_PREFIX = 'new_item.';

const INTERVAL_PROPERTY = {
  type: 'integer',
  title: 'Check every (minutes)',
  description: 'How often Kortix checks the app. A new item fires within this many minutes.',
  enum: [...INTERVAL_MINUTES],
  default: DEFAULT_INTERVAL_MINUTES,
};

/** Seconds between checks. Any whole number of minutes from 1 to 1440 works; the schema offers the presets. */
export function intervalSeconds(config: Record<string, unknown>): number {
  const minutes = Math.round(Number(config.interval));
  return Number.isFinite(minutes) && minutes >= 1 ? Math.min(minutes, 1440) * 60 : DEFAULT_INTERVAL_MINUTES * 60;
}

/** The config without `interval`: what the stream reads. A changed interval keeps the stream. */
export function streamConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { interval: _interval, ...rest } = config;
  return rest;
}

export interface PollItem {
  /** Stable per item (or per item version): the dedup key. */
  key: string;
  /** The vendor's own time of the item, epoch ms. Null: unknown. */
  time: number | null;
  data: Record<string, unknown>;
}

export interface PollRequest {
  args: Record<string, unknown>;
  /** Pages one check reads at most, through `nextPageToken`. */
  maxPages: number;
  /** The tool lists newest first: stop paging at the first page that reaches a known or too-old item. */
  newestFirst?: boolean;
}

export interface PollContext {
  now: number;
  /** Items older than this never fire (see `planCheck`). */
  floor: number;
}

export interface EventDefinition extends EventTypeInfo {
  tool: string;
  request(config: Record<string, unknown>, ctx: PollContext): PollRequest;
  /** Null: the answer has no item list (a tool or format change). */
  items(output: unknown): PollItem[] | null;
}

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Epoch ms from an ISO string or an epoch-ms number/string; null when neither. */
export function timeOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^\d{10,16}$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * The tool's answer as JSON: MCP `structuredContent`, else the first text
 * content block parsed. Null when it is neither.
 */
export function parseToolOutput(output: unknown): unknown {
  if (Array.isArray(output)) {
    const block = output.find((b) => asRecord(b)?.type === 'text');
    const text = asRecord(block)?.text;
    if (typeof text !== 'string') return output.some((b) => asRecord(b)?.type) ? null : output;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return output ?? null;
}

export function nextPageToken(parsed: unknown): string | null {
  return str(asRecord(parsed)?.nextPageToken);
}

// Event data lands in a prompt, a run record and a job payload: bounded, no control characters.
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;
const MAX_DATA_BYTES = 16 * 1024;

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const clean = (text: string, max: number): string => {
  const stripped = text.replace(UNSAFE_CHARS, '');
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
};

function bound(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return clean(value, MAX_STRING);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => bound(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([k, v]) => [clean(k, 200), bound(v, depth + 1)]));
}

export function boundData(data: Json, key: string): Json {
  const bounded = bound(data, 0) as Json;
  const text = JSON.stringify(bounded);
  if (text.length <= MAX_DATA_BYTES) return bounded;
  return { id: bounded.id ?? key, truncated: true, preview: text.slice(0, 4_096) };
}

/** A key that is safe as an idempotency-key segment; long or unusual keys are hashed. */
export function eventIdOf(key: string): string {
  return /^[\w.:@+-]{1,128}$/.test(key) ? key : `h_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

// ─── Gmail ──────────────────────────────────────────────────────────────────

/** Labels of mail the user wrote: a trigger that replies by email must not fire on its own reply. */
const OWN_MAIL_LABELS = new Set(['SENT', 'DRAFT']);

function gmailItems(output: unknown): PollItem[] | null {
  const body = asRecord(parseToolOutput(output));
  if (!body) return null;
  // Gmail answers `{}` for zero matches.
  if (body.threads === undefined) return [];
  if (!Array.isArray(body.threads)) return null;
  const items: PollItem[] = [];
  for (const raw of body.threads) {
    const thread = asRecord(raw);
    const threadId = str(thread?.id);
    if (!thread || !threadId) continue;
    for (const rawMessage of Array.isArray(thread.messages) ? thread.messages : []) {
      const message = asRecord(rawMessage);
      const id = str(message?.id);
      if (!message || !id) continue;
      const labels = strings(message.labelIds);
      if (labels.some((label) => OWN_MAIL_LABELS.has(label))) continue;
      // internalDate is when Gmail received it; the Date header is the sender's claim.
      const time = timeOf(message.internalDate) ?? timeOf(message.date);
      items.push({
        key: id,
        time,
        data: {
          id,
          thread_id: threadId,
          subject: str(message.subject),
          from: str(message.sender),
          to: strings(message.toRecipients),
          cc: strings(message.ccRecipients),
          date: iso(time),
          snippet: str(message.snippet),
          labels,
          url: str(message.viewUrl),
          thread_url: str(thread.viewUrl),
          message_count: typeof thread.messageCount === 'number' ? thread.messageCount : null,
        },
      });
    }
  }
  return items;
}

const gmailMessageReceived: EventDefinition = {
  type: 'gmail.message.received',
  name: 'New email',
  description: 'An email arrives that matches your search. Mail you send and drafts never fire.',
  app: 'gmail',
  delivery: 'poll',
  tool: 'search_threads',
  configSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        title: 'Only emails that match',
        description: 'A Gmail search, such as from:billing@example.com has:attachment. Empty: every email that arrives in the inbox.',
        examples: ['from:billing@example.com has:attachment'],
      },
      interval: INTERVAL_PROPERTY,
    },
  },
  payloadSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Gmail message id. To read the whole email, call get_message with it.' },
      thread_id: { type: 'string', description: 'Gmail thread id (get_thread).' },
      subject: { type: 'string', description: 'Subject line.' },
      from: { type: 'string', description: 'Sender email address.' },
      to: { type: 'array', items: { type: 'string' }, description: 'To recipients.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Cc recipients.' },
      date: { type: 'string', description: 'When Gmail received it (ISO 8601).' },
      snippet: { type: 'string', description: 'Start of the message body.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Gmail label ids, such as INBOX and UNREAD.' },
      url: { type: 'string', description: 'Link to the message in Gmail.' },
      thread_url: { type: 'string', description: 'Link to the thread in Gmail.' },
      message_count: { type: 'integer', description: 'Messages in the thread.' },
    },
  },
  request(config) {
    const query = str(config.query)?.trim() ?? 'in:inbox';
    // The 2-day window bounds each check; the floor (24 h) is inside it.
    return { args: { query: `(${query}) newer_than:2d`, pageSize: 50, view: 'THREAD_VIEW_MINIMAL' }, maxPages: 4, newestFirst: true };
  },
  items: gmailItems,
};

// ─── Google Calendar ────────────────────────────────────────────────────────

/** list_events takes local times with no offset; with timeZone UTC a naive UTC time is exact. */
const naiveUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const DAY_MS = 24 * 60 * 60_000;
const LOOKAHEAD_DAYS = [7, 30, 90, 365];

function calendarItems(output: unknown): PollItem[] | null {
  const body = asRecord(parseToolOutput(output));
  if (!body) return null;
  if (body.events === undefined) return [];
  if (!Array.isArray(body.events)) return null;
  const items: PollItem[] = [];
  for (const raw of body.events) {
    const event = asRecord(raw);
    const id = str(event?.id);
    if (!event || !id || event.status === 'cancelled') continue;
    const start = asRecord(event.start);
    const end = asRecord(event.end);
    const conference = asRecord(asRecord(event.conferenceData)?.videoEntryPoint);
    // A repeating event fires once, for the series.
    const key = str(event.recurringEventId) ?? id;
    items.push({
      key,
      time: timeOf(event.created),
      data: {
        id,
        series_id: str(event.recurringEventId),
        title: str(event.summary),
        description: str(event.description),
        location: str(event.location),
        start: str(start?.dateTime) ?? str(start?.date),
        end: str(end?.dateTime) ?? str(end?.date),
        all_day: !str(start?.dateTime),
        status: str(event.status) ?? 'confirmed',
        organizer: str(asRecord(event.organizer)?.email),
        creator: str(asRecord(event.creator)?.email),
        attendees: (Array.isArray(event.attendees) ? event.attendees : []).flatMap((a) => {
          const attendee = asRecord(a);
          const email = str(attendee?.email);
          return email ? [{ email, name: str(attendee?.displayName), response: str(attendee?.responseStatus) }] : [];
        }),
        url: str(event.htmlLink),
        meeting_url: str(conference?.uri) ?? str(event.conferenceUrl),
        created: str(event.created),
        updated: str(event.updated),
      },
    });
  }
  return items;
}

const calendarEventCreated: EventDefinition = {
  type: 'google_calendar.event.created',
  name: 'New event',
  description: 'Someone adds an event to the calendar. A new repeating event fires once.',
  app: 'google_calendar',
  delivery: 'poll',
  tool: 'list_events',
  configSchema: {
    type: 'object',
    properties: {
      calendar_id: { type: 'string', title: 'Calendar', description: 'Calendar ID, such as team@example.com. Empty: your primary calendar.' },
      query: { type: 'string', title: 'Only events that match', description: 'Words that must all appear in the title, description, location or guests. Empty: every event.' },
      lookahead_days: {
        type: 'integer',
        title: 'Look ahead (days)',
        description: 'Kortix sees events that start within this many days from now.',
        enum: LOOKAHEAD_DAYS,
        default: 30,
      },
      interval: INTERVAL_PROPERTY,
    },
  },
  payloadSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event id (get_event).' },
      series_id: { type: ['string', 'null'], description: 'Id of the repeating series, when the event repeats.' },
      title: { type: 'string', description: 'Event title.' },
      description: { type: 'string', description: 'Event description.' },
      location: { type: 'string', description: 'Event location.' },
      start: { type: 'string', description: 'Start time (ISO 8601), or the date of an all-day event.' },
      end: { type: 'string', description: 'End time (ISO 8601), or the date of an all-day event.' },
      all_day: { type: 'boolean', description: 'True for an all-day event.' },
      organizer: { type: 'string', description: 'Organizer email address.' },
      creator: { type: 'string', description: 'Creator email address.' },
      attendees: { type: 'array', description: 'Guests: email, name and response.' },
      url: { type: 'string', description: 'Link to the event in Google Calendar.' },
      meeting_url: { type: ['string', 'null'], description: 'Video meeting link.' },
      created: { type: 'string', description: 'When the event was created (ISO 8601).' },
    },
  },
  request(config, ctx) {
    const days = LOOKAHEAD_DAYS.includes(Number(config.lookahead_days)) ? Number(config.lookahead_days) : 30;
    const calendarId = str(config.calendar_id)?.trim();
    const query = str(config.query)?.trim();
    return {
      args: {
        ...(calendarId ? { calendarId } : {}),
        startTime: naiveUtc(ctx.now - DAY_MS),
        endTime: naiveUtc(ctx.now + days * DAY_MS),
        timeZone: 'UTC',
        pageSize: 250,
        ...(query ? { fullText: query } : {}),
      },
      maxPages: 4,
    };
  },
  items: calendarItems,
};

// ─── Google Drive ───────────────────────────────────────────────────────────

const DRIVE_FOLDER_ID = /^[A-Za-z0-9_-]{10,}$/;

function driveItems(output: unknown): PollItem[] | null {
  const body = asRecord(parseToolOutput(output));
  if (!body) return null;
  if (body.files === undefined) return [];
  if (!Array.isArray(body.files)) return null;
  return body.files.flatMap((raw): PollItem[] => {
    const file = asRecord(raw);
    const id = str(file?.id);
    if (!file || !id) return [];
    return [{
      key: id,
      time: timeOf(file.createdTime),
      data: {
        id,
        title: str(file.title),
        mime_type: str(file.mimeType),
        url: str(file.viewUrl),
        folder_id: str(file.parentId),
        owner: str(file.owner),
        created: str(file.createdTime),
        modified: str(file.modifiedTime),
        size: str(file.fileSize),
        extension: str(file.fileExtension),
      },
    }];
  });
}

const driveFileCreated: EventDefinition = {
  type: 'google_drive.file.created',
  name: 'New file',
  description: 'A file is created in Drive, or in the folder you pick.',
  app: 'google_drive',
  delivery: 'poll',
  tool: 'search_files',
  configSchema: {
    type: 'object',
    properties: {
      folder_id: {
        type: 'string',
        title: 'Folder',
        description: 'ID of the folder to watch: the part of the folder URL after /folders/. Empty: every file you can open in Drive.',
      },
      query: {
        type: 'string',
        title: 'Only files that match',
        description: "A Drive search clause, such as mimeType = 'application/pdf' or title contains 'invoice'.",
      },
      interval: INTERVAL_PROPERTY,
    },
  },
  payloadSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Drive file id (read_file_content, get_file_metadata).' },
      title: { type: 'string', description: 'File name.' },
      mime_type: { type: 'string', description: 'MIME type.' },
      url: { type: 'string', description: 'Link to the file.' },
      folder_id: { type: ['string', 'null'], description: 'Parent folder id.' },
      owner: { type: 'string', description: 'Owner email address.' },
      created: { type: 'string', description: 'When the file was created (ISO 8601).' },
    },
  },
  request(config, ctx) {
    const folder = str(config.folder_id)?.trim();
    if (folder && !DRIVE_FOLDER_ID.test(folder)) {
      throw new Error('folder_id must be a Drive folder ID: the part of the folder URL after /folders/.');
    }
    const query = str(config.query)?.trim();
    const clauses = [
      // 2 minutes of overlap for search-index lag; `seen` drops the repeats.
      `createdTime > '${new Date(ctx.floor - 2 * 60_000).toISOString()}'`,
      ...(folder ? [`parentId = '${folder}'`] : []),
      ...(query ? [`(${query})`] : []),
    ];
    return { args: { query: clauses.join(' and '), pageSize: 50, excludeContentSnippets: true }, maxPages: 4 };
  },
  items: driveItems,
};

export const CURATED_EVENTS: readonly EventDefinition[] = [gmailMessageReceived, calendarEventCreated, driveFileCreated];

export const curatedEventsFor = (app: string): EventDefinition[] => CURATED_EVENTS.filter((d) => d.app === app);

// ─── Generic: any read-only list tool ───────────────────────────────────────

/** A synced tool of the connector (`connector_actions`). */
export interface ToolAction {
  path: string;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  risk: string;
  bindingKind: string | null;
}

const ID_LIKE = /^(id|.*_id|.*Id|.*_ids|.*Ids)$/;
const PAGINATION = /^(cursor|after|before|offset|page|page_?token|next_?page_?token|starting_?after|ending_?before)$/i;
const ITEM_ID_FIELDS = ['id', 'uuid', 'uri', 'url', 'key'];
const ITEM_TIME_FIELDS = [
  'created_at', 'createdAt', 'createdTime', 'created', 'creation_time',
  'updated_at', 'updatedAt', 'modifiedTime', 'updated', 'date', 'timestamp',
];

/** The JSON schema at `$ref` (`#/$defs/X` or `#/definitions/X`), one level. */
function deref(schema: Json | null, root: Json | null): Json | null {
  const ref = str(schema?.$ref);
  if (!ref || !root) return schema;
  const name = ref.split('/').pop() ?? '';
  return asRecord(asRecord(root.$defs)?.[name]) ?? asRecord(asRecord(root.definitions)?.[name]) ?? schema;
}

/** The items schema of the first array property within depth 2 of an output schema; undefined when none. */
function listItemsSchema(output: Json | null): Json | null | undefined {
  if (!output) return undefined;
  if (output.type === 'array') return deref(asRecord(output.items), output);
  const queue: Array<{ schema: Json | null; depth: number }> = [{ schema: output, depth: 0 }];
  while (queue.length) {
    const { schema, depth } = queue.shift()!;
    for (const prop of Object.values(asRecord(schema?.properties) ?? {})) {
      const resolved = deref(asRecord(prop), output);
      if (resolved?.type === 'array') return deref(asRecord(resolved.items), output);
      if (depth < 1 && resolved?.type === 'object') queue.push({ schema: resolved, depth: depth + 1 });
    }
  }
  return undefined;
}

/** A tool that lists or searches: read-only, an MCP tool, needs no item id, and answers with a list when it says. */
export function isListTool(action: ToolAction): boolean {
  if (action.risk !== 'read' || action.bindingKind !== 'mcp') return false;
  const required = strings(action.inputSchema?.required);
  if (required.some((key) => ID_LIKE.test(key))) return false;
  return action.outputSchema ? listItemsSchema(action.outputSchema) !== undefined : true;
}

const firstSentence = (text: string): string => {
  const sentence = text.trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
};

/** The first list in the answer: the answer itself, else breadth-first to depth 2. */
export function findList(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  const root = asRecord(parsed);
  if (!root) return null;
  if (Object.keys(root).length === 0) return [];
  const queue: Array<{ value: Json; depth: number }> = [{ value: root, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.shift()!;
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) return child;
      const record = asRecord(child);
      if (record && depth < 1) queue.push({ value: record, depth: depth + 1 });
    }
  }
  return null;
}

function genericItem(raw: unknown): PollItem {
  const item = asRecord(raw) ?? { value: raw };
  const idField = ITEM_ID_FIELDS.find((f) => typeof item[f] === 'string' || typeof item[f] === 'number');
  const key = idField
    ? String(item[idField])
    : `h_${createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 40)}`;
  const timeField = ITEM_TIME_FIELDS.find((f) => timeOf(item[f]) !== null);
  return { key, time: timeField ? timeOf(item[timeField]) : null, data: item };
}

export function genericEventFor(action: ToolAction, app: string): EventDefinition {
  const input = action.inputSchema ?? {};
  const properties = Object.fromEntries(
    Object.entries(asRecord(input.properties) ?? {})
      .filter(([key]) => !PAGINATION.test(key) && key !== 'interval')
      .map(([key, prop]) => {
        const spec = { ...(asRecord(prop) ?? {}) };
        if (typeof spec.description === 'string' && spec.description.length > 300) spec.description = `${spec.description.slice(0, 299)}…`;
        return [key, spec];
      }),
  );
  const required = strings(input.required).filter((key) => key in properties);
  const itemsSchema = listItemsSchema(action.outputSchema);
  const summary = action.description ? `${firstSentence(action.description)} ` : '';
  return {
    type: `${GENERIC_PREFIX}${action.path}`,
    name: `New item from ${action.name}`,
    description: `${summary}Kortix runs ${action.name} on every check and fires once for each item it has not returned before.`,
    app,
    delivery: 'poll',
    tool: action.path,
    configSchema: { type: 'object', properties: { ...properties, interval: INTERVAL_PROPERTY }, ...(required.length ? { required } : {}) },
    payloadSchema: itemsSchema && itemsSchema.type === 'object' ? itemsSchema : null,
    request(config) {
      return { args: streamConfig(config), maxPages: 1 };
    },
    items(output) {
      const list = findList(parseToolOutput(output));
      return list ? list.map(genericItem) : null;
    },
  };
}

// ─── Deciding what fires ────────────────────────────────────────────────────

/** Items older than this never fire: after an outage, a re-prime or a seen-set eviction. */
export const MAX_EVENT_AGE_MS = DAY_MS;
/** A vendor time this far ahead of the Kortix clock is a forged or wrong time. */
export const MAX_FUTURE_SKEW_MS = 10 * 60_000;
export const MAX_FIRES_PER_CHECK = 20;
export const MAX_FIRES_PER_HOUR = 60;
/** Items one check considers: a list tool can answer with any number. */
export const MAX_ITEMS_PER_CHECK = 1_000;
export const MAX_SEEN = 2_000;

/** Items before this never fire. `subscribedAt` minus a minute absorbs the vendor's clock skew. */
export function floorFor(subscribedAt: number, now: number): number {
  return Math.max(subscribedAt - 60_000, now - MAX_EVENT_AGE_MS);
}

export interface CheckPlan {
  fire: PollItem[];
  /** New items left for the next check (over the per-check cap, hourly budget left). */
  deferred: number;
  /** New items marked seen without firing: the hourly budget is spent. */
  dropped: number;
  nextSeen: string[];
}

/**
 * One check's decision. An item fires when its key is new and:
 * - it has a vendor time between `floor` and now + 10 min, or
 * - it has no time and the stream is primed (a first check records untimed items).
 * Oldest first; at most 20 per check and 60 per hour.
 */
export function planCheck(input: {
  items: readonly PollItem[];
  seen: readonly string[];
  primed: boolean;
  floor: number;
  now: number;
  firesThisHour: number;
}): CheckPlan {
  const seen = new Set(input.seen);
  const visible: PollItem[] = [];
  const keys = new Set<string>();
  for (const item of input.items) {
    if (keys.has(item.key)) continue;
    keys.add(item.key);
    visible.push(item);
  }
  const fresh = visible.filter((item) => {
    if (seen.has(item.key)) return false;
    if (item.time === null) return input.primed;
    return item.time >= input.floor && item.time <= input.now + MAX_FUTURE_SKEW_MS;
  });
  // Lists answer newest first: untimed items keep that order reversed, after the timed ones.
  const untimed = fresh.filter((i) => i.time === null).reverse();
  const ordered = [...fresh.filter((i) => i.time !== null).sort((a, b) => a.time! - b.time! || (a.key < b.key ? -1 : 1)), ...untimed];
  const budget = Math.max(0, MAX_FIRES_PER_HOUR - input.firesThisHour);
  const fire = ordered.slice(0, Math.min(MAX_FIRES_PER_CHECK, budget));
  const rest = ordered.slice(fire.length);
  const deferredKeys = budget > fire.length ? new Set(rest.map((i) => i.key)) : new Set<string>();
  const visibleKeys = visible.map((i) => i.key).filter((k) => !deferredKeys.has(k));
  const visibleSet = new Set(visibleKeys);
  const nextSeen = [...visibleKeys, ...input.seen.filter((k) => !visibleSet.has(k) && !deferredKeys.has(k))].slice(0, MAX_SEEN);
  return { fire, deferred: deferredKeys.size, dropped: rest.length - deferredKeys.size, nextSeen };
}
