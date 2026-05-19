import type { ParsedManifest } from '../projects/triggers';
import { MANIFEST_FILENAME } from '../projects/triggers';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SLASH_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CHANNEL_ID_RE = /^[A-Z0-9]{2,32}$/;

export const SUPPORTED_PLATFORMS = [
  'slack',
] as const;
export type ChannelPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export const CHANNEL_EVENTS = ['mention', 'dm', 'subscribed', 'slash', 'action'] as const;
export type ChannelEvent = (typeof CHANNEL_EVENTS)[number];

export const CHANNEL_RESPONSE_STYLES = ['plan', 'text', 'none'] as const;
export type ChannelResponseStyle = (typeof CHANNEL_RESPONSE_STYLES)[number];

export interface ChannelSlashCommand {
  name: string;
  promptTemplate: string;
}

export interface ChannelSpec {
  slug: string;
  path: string;
  name: string;
  platform: ChannelPlatform;
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  agent: string;
  promptPrefix: string;
  events: ChannelEvent[];
  responseStyle: ChannelResponseStyle;
  maxConcurrentSessions: number | null;
  slashCommands: ChannelSlashCommand[];
}

export interface ChannelParseError {
  slug: string;
  path: string;
  error: string;
}

export interface LoadedChannels {
  specs: ChannelSpec[];
  errors: ChannelParseError[];
}

export function extractChannels(manifest: ParsedManifest): LoadedChannels {
  const raw = manifest.raw.channels;
  if (raw === undefined || raw === null) {
    return { specs: [], errors: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      specs: [],
      errors: [{
        slug: '(top-level)',
        path: MANIFEST_FILENAME,
        error: '`channels` must be an array of tables — use [[channels]], not [channels]',
      }],
    };
  }

  const specs: ChannelSpec[] = [];
  const errors: ChannelParseError[] = [];
  const seenSlugs = new Set<string>();
  const seenBindings = new Set<string>();

  raw.forEach((entry, index) => {
    const result = parseChannelEntry(entry, index);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    const spec = result.spec;
    if (seenSlugs.has(spec.slug)) {
      errors.push({
        slug: spec.slug,
        path: spec.path,
        error: `Duplicate channel slug "${spec.slug}" — slugs must be unique within a project`,
      });
      return;
    }
    const bindingKey = spec.channelId
      ? `${spec.platform}:id:${spec.channelId}`
      : `${spec.platform}:name:${spec.channelName}`;
    if (seenBindings.has(bindingKey)) {
      errors.push({
        slug: spec.slug,
        path: spec.path,
        error: `Two [[channels]] entries point at the same ${spec.platform} channel — bindings must be unique`,
      });
      return;
    }
    seenSlugs.add(spec.slug);
    seenBindings.add(bindingKey);
    specs.push(spec);
  });

  specs.sort((a, b) => a.slug.localeCompare(b.slug));
  errors.sort((a, b) => a.slug.localeCompare(b.slug));
  return { specs, errors };
}

export function channelSpecToTomlEntry(spec: ChannelSpec): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    slug: spec.slug,
    name: spec.name,
    platform: spec.platform,
    enabled: spec.enabled,
    agent: spec.agent,
    events: spec.events,
    response: spec.responseStyle,
    prompt_prefix: spec.promptPrefix,
  };
  if (spec.channelId) entry.channel_id = spec.channelId;
  if (spec.channelName) entry.channel_name = spec.channelName;
  if (spec.maxConcurrentSessions !== null) {
    entry.max_concurrent_sessions = spec.maxConcurrentSessions;
  }
  if (spec.slashCommands.length > 0) {
    entry.slash_commands = spec.slashCommands.map((cmd) => ({
      name: cmd.name,
      prompt: cmd.promptTemplate,
    }));
  }
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

  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!slug) return err(`(index-${index})`, `[[channels]] entry #${index + 1} is missing a slug`);
  if (!SLUG_RE.test(slug)) {
    return err(slug, `Invalid slug "${slug}" — lowercase letters, digits, dashes, underscores only`);
  }

  const platformRaw = typeof row.platform === 'string' ? row.platform.trim().toLowerCase() : '';
  if (!isSupportedPlatform(platformRaw)) {
    return err(
      slug,
      `Unsupported platform "${platformRaw || 'unset'}" — must be one of ${SUPPORTED_PLATFORMS.join(', ')}`,
    );
  }
  const platform = platformRaw;

  const channelId = stringField(row, 'channel_id', 'channelId');
  const channelName = stringField(row, 'channel_name', 'channelName');
  if (!channelId && !channelName) {
    return err(slug, 'channel_id or channel_name is required');
  }
  if (channelId && channelName) {
    return err(slug, 'set channel_id or channel_name, not both');
  }
  if (platform === 'slack' && channelId && !CHANNEL_ID_RE.test(channelId)) {
    return err(slug, `Slack channel_id "${channelId}" does not look right (expected uppercase letters/digits)`);
  }

  const prompt = stringField(row, 'prompt_prefix', 'promptPrefix', 'prompt');
  if (!prompt) return err(slug, 'prompt_prefix is required');

  const name = stringField(row, 'name') || slug;
  const agent = stringField(row, 'agent', 'agent_name') || 'default';
  const enabled = coerceBool(row.enabled, true);

  const eventsResult = parseEvents(row.events, slug);
  if (!eventsResult.ok) return eventsResult;
  const events = eventsResult.value;

  const responseRaw = stringField(row, 'response', 'response_style').toLowerCase();
  const responseStyle: ChannelResponseStyle =
    responseRaw && isResponseStyle(responseRaw) ? responseRaw : 'text';

  let maxConcurrentSessions: number | null = null;
  if (row.max_concurrent_sessions !== undefined && row.max_concurrent_sessions !== null) {
    const raw = Number(row.max_concurrent_sessions);
    if (!Number.isFinite(raw) || raw < 1 || !Number.isInteger(raw)) {
      return err(slug, 'max_concurrent_sessions must be a positive integer');
    }
    maxConcurrentSessions = raw;
  }

  const slashResult = parseSlashCommands(row.slash_commands, slug);
  if (!slashResult.ok) return slashResult;
  const slashCommands = slashResult.value;

  if (events.includes('slash') && slashCommands.length === 0) {
    return err(slug, 'events includes "slash" but no [[channels.slash_commands]] are declared');
  }

  return {
    ok: true,
    spec: {
      slug,
      path: `${MANIFEST_FILENAME}#channels.${slug}`,
      name,
      platform,
      enabled,
      channelId: channelId || null,
      channelName: channelName || null,
      agent,
      promptPrefix: prompt,
      events,
      responseStyle,
      maxConcurrentSessions,
      slashCommands,
    },
  };
}

function parseEvents(
  raw: unknown,
  slug: string,
): { ok: true; value: ChannelEvent[] } | ParseErr {
  if (raw === undefined || raw === null) {
    return { ok: true, value: ['mention'] };
  }
  if (!Array.isArray(raw)) {
    return err(slug, 'events must be an array of strings');
  }
  const result: ChannelEvent[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return err(slug, 'events must be an array of strings');
    }
    const e = entry.trim().toLowerCase();
    if (!isChannelEvent(e)) {
      return err(slug, `Unknown event "${entry}" — must be one of ${CHANNEL_EVENTS.join(', ')}`);
    }
    if (seen.has(e)) continue;
    seen.add(e);
    result.push(e);
  }
  if (result.length === 0) result.push('mention');
  return { ok: true, value: result };
}

function parseSlashCommands(
  raw: unknown,
  slug: string,
): { ok: true; value: ChannelSlashCommand[] } | ParseErr {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return err(slug, 'slash_commands must be an array of tables — use [[channels.slash_commands]]');
  }
  const out: ChannelSlashCommand[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const cmd = raw[i];
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      return err(slug, `slash_commands entry #${i + 1} is not a table`);
    }
    const row = cmd as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim().replace(/^\//, '') : '';
    if (!name) return err(slug, `slash_commands entry #${i + 1} is missing a name`);
    if (!SLASH_RE.test(name)) {
      return err(slug, `Invalid slash command name "${name}" — lowercase letters, digits, dashes, underscores`);
    }
    if (seen.has(name)) {
      return err(slug, `Duplicate slash command "${name}"`);
    }
    const promptTemplate = typeof row.prompt === 'string'
      ? row.prompt
      : typeof row.prompt_template === 'string'
        ? row.prompt_template
        : '';
    if (!promptTemplate.trim()) {
      return err(slug, `slash command "${name}" is missing a prompt`);
    }
    seen.add(name);
    out.push({ name, promptTemplate });
  }
  return { ok: true, value: out };
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

function isResponseStyle(value: string): value is ChannelResponseStyle {
  return (CHANNEL_RESPONSE_STYLES as readonly string[]).includes(value);
}

function err(slug: string, message: string): ParseErr {
  return {
    ok: false,
    error: { slug, path: `${MANIFEST_FILENAME}#channels.${slug}`, error: message },
  };
}
