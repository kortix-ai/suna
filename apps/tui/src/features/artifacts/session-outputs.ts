/**
 * What the open session handed over: the outputs the tray names, the
 * `/shown` picker lists and the transcript's `show` card draws.
 *
 * Two sources, merged into one list, newest first:
 *
 * - **Shown.** Every `show` / `show_user` call in the thread: the agent's
 *   "here is what you asked for". The SDK's `showGroupItems` reads the
 *   payload (one item or `items[]`), as the web's chat does. A shown URL that
 *   is a Kortix artifact app link (`parseArtifactUrl`) is an artifact; any
 *   other URL is a running page; a path is a file in the session.
 * - **Published.** The project's artifacts whose `created_by_session_id` is
 *   this session: what `kortix artifacts publish` made, shown or not.
 *
 * One artifact shown twice, or shown and published, is one row: the newest
 * appearance decides its place, the artifact record decides its title.
 * Pure, so every rule is asserted directly.
 */

import {
  type SessionLogMessage,
  type ToolView,
  classifySessionLogMessage,
  parseArtifactUrl,
  showGroupItems,
} from '@kortix/sdk';

import { isShowTool } from '../../lib/turn-layout.ts';
import { type ArtifactLike, artifactWebUrl } from './artifacts-model.ts';

export type OutputKind = 'artifact' | 'page' | 'image' | 'video' | 'deck' | 'file';

export interface SessionOutput {
  /** Stable identity: `artifact:<id>`, `url:<url>` or `path:<path>`. */
  key: string;
  kind: OutputKind;
  title: string;
  description: string;
  /** What a browser opens. Absent for a file that only lives in the sandbox. */
  url: string | null;
  /** The file in the session, for a shown path. */
  path: string | null;
  /** Set for a Kortix artifact. */
  artifactId: string | null;
  /** `doc` or `html`, once the artifact record is known. */
  artifactType: string | null;
  /** When it last appeared: the message's time, or the artifact's last save. */
  atMs: number;
  /** The `show` call that handed it over, when one did. */
  callId: string | null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|heic|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|avi|mkv)$/i;
const DECK_EXT = /\.(pptx?|key)$/i;


function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function kindOfPath(path: string): OutputKind {
  if (IMAGE_EXT.test(path)) return 'image';
  if (VIDEO_EXT.test(path)) return 'video';
  if (DECK_EXT.test(path)) return 'deck';
  return 'file';
}

/** A host name for a page with no title: `localhost:3000`, `example.com`. */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

/** The items one finished `show` call handed over. A pending or failed call hands over nothing yet. */
export function shownItems(
  tool: Pick<ToolView, 'name' | 'status' | 'input' | 'error'>,
  callId: string,
  atMs: number,
): SessionOutput[] {
  if (!isShowTool(tool.name) || tool.status !== 'done') return [];
  const items = showGroupItems([
    {
      callID: callId,
      tool: tool.name,
      state: { status: 'completed', input: tool.input ?? {} },
    } as unknown as Parameters<typeof showGroupItems>[0][number],
  ]);
  const out: SessionOutput[] = [];
  for (const item of items) {
    if (item.status !== 'ready') continue;
    // No `title`: a short one-line `content` is the label the agent gave it
    // (a live run sent `{ type: 'url', url, content: 'TUI probe report' }`).
    const content = item.content?.trim() ?? '';
    const caption = content && content.length <= 120 && !content.includes('\n') ? content : '';
    const title = item.title?.trim() || caption;
    const description = item.description?.trim() ?? '';
    const url = item.url?.trim() ?? '';
    if (url && /^https?:\/\//i.test(url)) {
      const artifact = parseArtifactUrl(url);
      out.push(
        artifact
          ? {
              key: `artifact:${artifact.artifactId}`,
              kind: 'artifact',
              title: title || 'Artifact',
              description,
              url,
              path: null,
              artifactId: artifact.artifactId,
              artifactType: null,
              atMs,
              callId,
            }
          : {
              key: `url:${url}`,
              kind: 'page',
              title: title || hostOf(url),
              description,
              url,
              path: null,
              artifactId: null,
              artifactType: null,
              atMs,
              callId,
            },
      );
      continue;
    }
    // A path is a file the agent made in the sandbox. Inline `content` with no
    // path or URL is text in the chat, not a thing to open: no row.
    const path = (item.path || item.attachment || '').trim();
    if (!path) continue;
    out.push({
      key: `path:${path}`,
      kind: kindOfPath(path),
      title: title || basename(path),
      description,
      url: null,
      path,
      artifactId: null,
      artifactType: null,
      atMs,
      callId,
    });
  }
  return out;
}

function timeOf(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Every item the thread's `show` calls handed over, in thread order. */
export function threadOutputs(messages: readonly SessionLogMessage[]): SessionOutput[] {
  const out: SessionOutput[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const atMs = timeOf(message.completed_at) || timeOf(message.created_at);
    for (const part of classifySessionLogMessage(message).parts) {
      if (part.kind !== 'tool') continue;
      out.push(...shownItems(part.tool, part.id, atMs));
    }
  }
  return out;
}

/**
 * The session's outputs, newest first: the shown items plus the artifacts the
 * session published. One row per key; the artifact record names an artifact
 * and gives its browser link.
 */
export function sessionOutputs(input: {
  messages: readonly SessionLogMessage[];
  artifacts: readonly ArtifactLike[];
  sessionId: string;
  projectId: string;
  webBaseUrl: string;
}): SessionOutput[] {
  const byKey = new Map<string, SessionOutput>();
  const put = (item: SessionOutput) => {
    const current = byKey.get(item.key);
    if (!current || item.atMs >= current.atMs) byKey.set(item.key, current ? { ...current, ...item } : item);
  };
  for (const item of threadOutputs(input.messages)) put(item);

  const records = new Map<string, ArtifactLike>();
  for (const artifact of input.artifacts) records.set(artifact.artifact_id.toLowerCase(), artifact);

  for (const artifact of input.artifacts) {
    if (artifact.created_by_session_id !== input.sessionId) continue;
    const id = artifact.artifact_id.toLowerCase();
    const key = `artifact:${id}`;
    const shown = byKey.get(key);
    const atMs = Math.max(timeOf(artifact.updated_at), shown?.atMs ?? 0);
    byKey.set(key, {
      key,
      kind: 'artifact',
      title: artifact.title,
      description: artifact.description ?? shown?.description ?? '',
      url: artifactWebUrl(artifact.web_url, input.webBaseUrl, input.projectId, artifact.artifact_id),
      path: null,
      artifactId: id,
      artifactType: artifact.type,
      atMs,
      callId: shown?.callId ?? null,
    });
  }

  // A shown artifact this list does not hold (another project, a public
  // link, or a list not loaded yet) keeps the link and the title it was shown with.
  for (const [key, item] of byKey) {
    if (item.kind !== 'artifact' || !item.artifactId) continue;
    const record = records.get(item.artifactId);
    if (!record || record.created_by_session_id === input.sessionId) continue;
    byKey.set(key, {
      ...item,
      title: record.title,
      artifactType: record.type,
      url: artifactWebUrl(record.web_url, input.webBaseUrl, input.projectId, record.artifact_id),
    });
  }

  return [...byKey.values()].sort((a, b) => b.atMs - a.atMs);
}

/** The tray segment: `▣ Q3 churn report` for one, `▣ 3 outputs · Q3 churn report` for more. */
export function outputsSummary(outputs: readonly SessionOutput[]): string | null {
  const newest = outputs[0];
  if (!newest) return null;
  const title = newest.title.length > 32 ? `${newest.title.slice(0, 31)}…` : newest.title;
  return outputs.length === 1 ? title : `${outputs.length} outputs · ${title}`;
}

/** The words a prompt references an output with. An artifact link is what the agent's `kortix-artifacts` skill resolves. */
export function outputReference(output: SessionOutput): string {
  const target = output.url ?? output.path ?? '';
  const name = output.title.replace(/"/g, "'");
  return target ? `"${name}" (${target}) ` : `"${name}" `;
}

/** The kind word in a row's right column. */
export function outputKindLabel(output: SessionOutput): string {
  if (output.kind === 'artifact') return output.artifactType === 'doc' ? 'Doc' : output.artifactType === 'html' ? 'Page' : 'Artifact';
  if (output.kind === 'page') return 'Web page';
  if (output.kind === 'image') return 'Image';
  if (output.kind === 'video') return 'Video';
  if (output.kind === 'deck') return 'Slides';
  return 'File';
}
