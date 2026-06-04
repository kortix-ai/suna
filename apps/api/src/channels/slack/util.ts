import { createHmac, timingSafeEqual } from 'node:crypto';
import { FIVE_MINUTES } from './app';
import type { SlackEnvelope } from './types';

export function parseEnvelope(rawBody: string): SlackEnvelope | null {
  try {
    return JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return null;
  }
}

export function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  if (!timestamp || !signature) return false;
  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSec) || ageSec > FIVE_MINUTES) return false;

  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

export function repoOgImage(repoUrl: string): string | null {
  const m = repoUrl.match(/github\.com[\/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/i);
  if (!m) return null;
  return `https://opengraph.githubassets.com/1/${m[1]}/${m[2]}`;
}

export function repoLabel(repoUrl: string): string {
  return repoUrl
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '');
}

export function formatRelativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
