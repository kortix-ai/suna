import { decodeHtmlEntities } from './markdown';
import type { StreamTaskChunk } from '../slack-api';

export interface TeamsActivity {
  type: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string; name?: string };
  channelData?: {
    tenant?: { id?: string };
    team?: { id?: string; name?: string; aadGroupId?: string };
    channel?: { id?: string; name?: string };
  };
  replyToId?: string;
  entities?: Array<Record<string, unknown>>;
  name?: string;
  action?: string;
  membersAdded?: Array<{ id?: string; aadObjectId?: string }>;
  value?: unknown;
  attachments?: Array<{
    contentType?: string;
    contentUrl?: string;
    name?: string;
    /**
     * An object for a OneDrive file (`…file.download.info`), and a STRING of
     * HTML for `text/html` — which is how Teams delivers a message whose body
     * carries an inline image in a channel or group chat.
     */
    content?: string | { downloadUrl?: string; uniqueId?: string; fileType?: string };
  }>;
}

export interface TeamsAttachmentRef {
  name: string;
  downloadUrl: string;
  fileType?: string;
  /** An image the agent can look at directly once downloaded. */
  isImage?: boolean;
}

/** Teams sends inline images as the wildcard type `image/*`, with no filename. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
};

/**
 * Hosts an inline `<img src>` may point at that the download proxy can
 * authenticate against: Bot Framework attachment stores (the bot connector
 * token) and Graph hostedContents (a Graph token). Anything else — Teams' own
 * emoji CDN, a customer's image host — is not a file the user attached.
 */
const INLINE_IMAGE_HOST = /(^smba\.trafficmanager\.net|(^|\.)botframework\.com|(^|\.)botframework\.us|^graph\.microsoft\.com)$/i;

/**
 * The images a Teams message carries INLINE in its HTML body.
 *
 * In a personal chat a pasted image arrives as an `image/*` attachment. In a
 * channel or a group chat it arrives inside a `text/html` attachment as an
 * `<img>` tag, and nothing parsed those — so an image pasted into a channel was
 * invisible: no attachment for the agent to download, and `teamsMessageHasImage`
 * returned false, so the turn was never routed to a model that can see it.
 *
 * Teams also renders its own emoji as `<img itemtype="…/Emoji">`. Those are
 * skipped explicitly, and the host allowlist would reject them anyway.
 */
export function inlineImageUrls(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (/itemtype\s*=\s*["'][^"']*Emoji/i.test(tag)) continue;
    const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const raw = m?.[1] ?? m?.[2];
    if (!raw) continue;
    const src = decodeHtmlEntities(raw.trim());
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !INLINE_IMAGE_HOST.test(url.hostname)) continue;
    if (!out.includes(url.href)) out.push(url.href);
  }
  return out;
}

export function extractTeamsAttachments(activity: TeamsActivity): TeamsAttachmentRef[] {
  const out: TeamsAttachmentRef[] = [];
  const htmlBodies: string[] = [];
  for (const a of activity.attachments ?? []) {
    // A message body with inline content: collected here, parsed below once the
    // explicit attachments are known, so an image Teams sends BOTH ways (a
    // personal chat can) is listed once.
    if (a.contentType === 'text/html' && typeof a.content === 'string') {
      htmlBodies.push(a.content);
      continue;
    }
    // A file shared from OneDrive (personal chat): a pre-authorized download URL.
    const file = typeof a.content === 'object' && a.content ? a.content : undefined;
    if (a.contentType === 'application/vnd.microsoft.teams.file.download.info' && file?.downloadUrl) {
      out.push({ name: a.name ?? 'file', downloadUrl: file.downloadUrl, fileType: file.fileType });
      continue;
    }
    // An image pasted or dragged into the composer: `image/*` with a Bot
    // Framework attachment URL that needs the bot connector token to fetch
    // (channels/teams/file-proxy.ts attaches it).
    if (a.contentType?.startsWith('image/') && a.contentUrl) {
      const subtype = a.contentType.slice('image/'.length).split(';')[0].trim().toLowerCase();
      // `image/*` carries no real subtype — name the file without a misleading
      // extension rather than `image.*`, which is not a filename.
      const ext = IMAGE_EXTENSIONS[subtype];
      out.push({
        name: a.name ?? (ext ? `image.${ext}` : 'image'),
        downloadUrl: a.contentUrl,
        ...(ext ? { fileType: ext } : {}),
        isImage: true,
      });
    }
  }
  const seen = new Set(out.map((a) => a.downloadUrl));
  let n = 0;
  for (const html of htmlBodies) {
    for (const src of inlineImageUrls(html)) {
      if (seen.has(src)) continue;
      seen.add(src);
      n += 1;
      // The HTML carries no filename and no reliable type; name it plainly and
      // let the downloaded Content-Type say what it is.
      out.push({ name: n === 1 ? 'image' : `image-${n}`, downloadUrl: src, isImage: true });
    }
  }
  return out;
}

export interface TeamsConversationRef {
  serviceUrl: string;
  conversationId: string;
  botId?: string;
  fromId?: string;
  tenantId?: string;
  projectId?: string;
}

export interface TeamsChannelRef {
  platform: 'teams';
  serviceUrl: string;
  conversationId: string;
  botId?: string;
  fromId?: string;
  /**
   * Set once the agent has replied for this turn (answer, question or review
   * card): the runtime turn tokens that were live then. A later relay from one
   * of THOSE turns is a stray and is dropped; one from any other turn is new
   * work and opens a card. See `replyMarkerCoversRuntime` in turn.ts.
   */
  repliedTurns?: string[];
}

export interface TeamsLiveTurn {
  conversationId: string;
  tenantId: string;
  serviceUrl: string;
  botId?: string;
  fromId?: string;
  triggerActivityId: string;
  messageActivityId: string;
  steps: StreamTaskChunk[];
  expiry: number;
  finalized: boolean;
  /** When the row last changed — a turn that has not moved is not "in flight". */
  updatedAt?: number;
  projectId: string;
  sessionId: string;
  originatingActivity: TeamsActivity;
  /** Present on a closed turn the agent already replied in: see TeamsChannelRef. */
  repliedTurns?: string[];
}

/** Does this message carry an image the model has to be able to see? */
export function teamsMessageHasImage(activity: TeamsActivity): boolean {
  return extractTeamsAttachments(activity).some((a) => a.isImage === true);
}
