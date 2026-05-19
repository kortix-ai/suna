import type { ParsedManifest } from '../projects/triggers';
import { MANIFEST_FILENAME } from '../projects/triggers';

export const SUPPORTED_PLATFORMS = ['slack'] as const;
export type ChannelPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export const CHANNEL_EVENTS = ['mention', 'dm', 'subscribed'] as const;
export type ChannelEvent = (typeof CHANNEL_EVENTS)[number];

/**
 * One [[channels]] entry per platform per project. The bot listens in any
 * channel of the project's connected workspace where it's been invited —
 * channel ids are deliberately NOT in the manifest. Everything except
 * `platform` is optional; sensible defaults below.
 */
export interface ChannelSpec {
  platform: ChannelPlatform;
  path: string;
  enabled: boolean;
  agent: string | null;
  promptPrefix: string | null;
  events: ChannelEvent[];
}

export interface ChannelParseError {
  platform: string;
  path: string;
  error: string;
}

export interface LoadedChannels {
  specs: ChannelSpec[];
  errors: ChannelParseError[];
}

const DEFAULT_EVENTS: ChannelEvent[] = ['mention', 'dm'];

export function extractChannels(manifest: ParsedManifest): LoadedChannels {
  const raw = manifest.raw.channels;
  if (raw === undefined || raw === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      specs: [],
      errors: [{
        platform: '(top-level)',
        path: MANIFEST_FILENAME,
        error: '`channels` must be an array of tables — use [[channels]], not [channels]',
      }],
    };
  }

  const specs: ChannelSpec[] = [];
  const errors: ChannelParseError[] = [];
  const seen = new Set<ChannelPlatform>();

  raw.forEach((entry, index) => {
    const result = parseChannelEntry(entry, index);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    if (seen.has(result.spec.platform)) {
      errors.push({
        platform: result.spec.platform,
        path: result.spec.path,
        error: `Duplicate [[channels]] entry for platform "${result.spec.platform}" — one per platform per project`,
      });
      return;
    }
    seen.add(result.spec.platform);
    specs.push(result.spec);
  });

  specs.sort((a, b) => a.platform.localeCompare(b.platform));
  errors.sort((a, b) => a.platform.localeCompare(b.platform));
  return { specs, errors };
}

export function channelSpecToTomlEntry(spec: ChannelSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = { platform: spec.platform };
  if (!spec.enabled) entry.enabled = false;
  if (spec.agent) entry.agent = spec.agent;
  if (spec.promptPrefix) entry.prompt_prefix = spec.promptPrefix;
  if (!eventsEqual(spec.events, DEFAULT_EVENTS)) entry.events = spec.events;
  return entry;
}

interface ParseOk {
  ok: true;
  spec: ChannelSpec;
}
interface ParseErr {
  ok: false;
  error: ChannelParseError;
}

function parseChannelEntry(entry: unknown, index: number): ParseOk | ParseErr {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return err('(invalid)', `[[channels]] entry #${index + 1} is not a table`);
  }
  const row = entry as Record<string, unknown>;

  const platformRaw = typeof row.platform === 'string' ? row.platform.trim().toLowerCase() : '';
  if (!isSupportedPlatform(platformRaw)) {
    return err(
      platformRaw || `(index-${index})`,
      `Unsupported platform "${platformRaw || 'unset'}" — must be one of ${SUPPORTED_PLATFORMS.join(', ')}`,
    );
  }
  const platform = platformRaw;

  const enabled = coerceBool(row.enabled, true);
  const agent = stringField(row, 'agent', 'agent_name');
  const promptPrefix = stringField(row, 'prompt_prefix', 'prompt');

  const eventsResult = parseEvents(row.events, platform);
  if (!eventsResult.ok) return eventsResult;
  const events = eventsResult.value;

  return {
    ok: true,
    spec: {
      platform,
      path: `${MANIFEST_FILENAME}#channels.${platform}`,
      enabled,
      agent: agent || null,
      promptPrefix: promptPrefix || null,
      events,
    },
  };
}

function parseEvents(
  raw: unknown,
  platform: ChannelPlatform,
): { ok: true; value: ChannelEvent[] } | ParseErr {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [...DEFAULT_EVENTS] };
  }
  if (!Array.isArray(raw)) {
    return err(platform, 'events must be an array of strings');
  }
  const result: ChannelEvent[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return err(platform, 'events must be an array of strings');
    }
    const e = entry.trim().toLowerCase();
    if (!isChannelEvent(e)) {
      return err(platform, `Unknown event "${entry}" — must be one of ${CHANNEL_EVENTS.join(', ')}`);
    }
    if (seen.has(e)) continue;
    seen.add(e);
    result.push(e);
  }
  if (result.length === 0) result.push(...DEFAULT_EVENTS);
  return { ok: true, value: result };
}

function stringField(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return fallback;
}

function isSupportedPlatform(value: string): value is ChannelPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

function isChannelEvent(value: string): value is ChannelEvent {
  return (CHANNEL_EVENTS as readonly string[]).includes(value);
}

function eventsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function err(platform: string, message: string): ParseErr {
  return {
    ok: false,
    error: {
      platform,
      path: `${MANIFEST_FILENAME}#channels.${platform}`,
      error: message,
    },
  };
}
