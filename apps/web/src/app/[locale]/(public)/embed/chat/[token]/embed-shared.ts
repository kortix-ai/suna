import type { PublicSessionTranscript } from '@kortix/sdk';

import {
  toShareLoadError,
  type ShareLoadError,
} from '@/app/[locale]/(public)/share/session/[token]/public-transcript';

/**
 * Pure decisions for the embed chat widget (`/embed/chat/[token]`). The page
 * stays a thin server shell; everything testable lives here.
 *
 * The widget is a read-only view of a `transcript` public share, fetched
 * server-side: a third-party host page frames this URL, and a browser inside
 * that frame cannot call the API cross-origin (the CORS allowlist is ours),
 * so the SSR fetch is what makes the embed work without widening CORS.
 */

/** How the host renders the widget. `inline` (default) centers a readable
 *  column; `panel` fills a narrow sidebar edge to edge; `modal` draws one
 *  card boundary so the widget reads as a dialog inside the host's modal. */
export type EmbedLayout = 'inline' | 'panel' | 'modal';

/** A host-built URL can carry anything; only the three shipped layouts exist.
 *  Anything else — including a non-string from a hand-built query — is the
 *  readable default. */
export function parseEmbedLayout(value: unknown): EmbedLayout {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (['inline', 'panel', 'modal'] as readonly string[]).includes(raw)
    ? (raw as EmbedLayout)
    : 'inline';
}

/**
 * The three class runs a layout changes. One owner, so the share page and the
 * embed never drift apart on the parts they share (canvas, definite height).
 */
export function embedFrameClasses(layout: EmbedLayout): {
  /** The page `<main>`: canvas tokens plus the layout's frame treatment. */
  root: string;
  /** The scroll region: where the conversation scrolls. */
  scroll: string;
  /** The message column inside the scroll region. */
  column: string;
} {
  if (layout === 'panel') {
    return {
      root: 'bg-background text-foreground flex h-dvh flex-col',
      scroll: 'h-full min-h-0 overflow-y-auto',
      // A sidebar is narrow: fill it edge to edge, tighter rhythm.
      column: 'w-full space-y-4 px-3 py-4 pb-8',
    };
  }
  if (layout === 'modal') {
    return {
      // One card boundary inside the frame: a host's modal shows the widget,
      // not a raw page edge. One boundary — a fill or a hairline, never both.
      root: 'bg-background text-foreground flex h-dvh flex-col p-3 sm:p-4',
      scroll: 'border-border h-full min-h-0 overflow-y-auto rounded-lg border',
      column: 'mx-auto w-full max-w-2xl space-y-6 px-4 py-8 pb-16',
    };
  }
  return {
    // Same shape as the share page's conversation region.
    root: 'bg-background text-foreground flex h-dvh flex-col',
    scroll: 'h-full min-h-0 overflow-y-auto',
    column: 'mx-auto w-full max-w-2xl space-y-6 px-4 py-10 pb-20',
  };
}

export type EmbedTranscriptResult =
  | { kind: 'ready'; transcript: PublicSessionTranscript }
  | { kind: 'error'; loadError: ShareLoadError | null };

/**
 * Read the transcript through the injected reader (the SDK's
 * `getPublicSessionShareMessages` under a scoped config) and normalize every
 * failure into a display-ready error. 404 = unknown token or a share that is
 * not a transcript (the messages read 404s for preview and file shares), 410 =
 * revoked or expired, 503 = nothing saved yet. A `null` reader means the web
 * deployment has no server-side backend URL at all — not an API answer, so the
 * page renders the generic failure. The page maps each state to copy via
 * `describeShareError`; this function only decides WHICH state renders.
 */
export async function loadEmbedTranscript(
  read: ((token: string) => Promise<PublicSessionTranscript>) | null,
  token: string,
): Promise<EmbedTranscriptResult> {
  if (!read) return { kind: 'error', loadError: null };
  try {
    return { kind: 'ready', transcript: await read(token) };
  } catch (err) {
    return { kind: 'error', loadError: toShareLoadError(err) };
  }
}
