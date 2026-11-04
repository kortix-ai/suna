import type {
  ArtifactCommentThread,
  ArtifactLiveColor,
  ArtifactLiveParticipant,
  ArtifactLiveStatus,
} from '@kortix/sdk';
import { createArtifactReanchorBudgets } from '@kortix/shared/artifact-comments';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { LIVE_BORDER, LIVE_TINT } from './artifact-live-colors';
import { docRangesForSource } from './doc-comment-positions';
import {
  cachedDocMarkdownPositions,
  docPositionForSource,
  resolveDocLiveCursor,
  resolveDocLiveRange,
} from './doc-live-positions';

export const docLivePluginKey = new PluginKey<DecorationSet>('artifactDocLive');

/** Someone else in the doc: a caret, a selection, or an agent's place. */
export interface DocLivePeer {
  /** The participant id: one caret per tab. */
  id: string;
  name: string;
  color: ArtifactLiveColor;
  /** An agent session: its label stays, with the agent glyph and `status`. */
  agent: boolean;
  /** The agent's status, in words ("Editing"). Null for a person. */
  status: string | null;
  cursor: { quote: string; prefix: string; offset: number } | null;
  selection: { quote: string; prefix: string; suffix: string } | null;
}

/** The first `max` code units of `text`, never half a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/**
 * What this viewer draws for each remote participant in the doc. A person
 * shows a caret and a selection; an agent shows its label at its doc cursor,
 * else at the passage of the thread it works on (its `focus`).
 */
export function docLivePeers(
  participants: readonly ArtifactLiveParticipant[],
  threads: readonly ArtifactCommentThread[],
  statusLabel: (status: ArtifactLiveStatus) => string,
): DocLivePeer[] {
  return participants.flatMap((participant): DocLivePeer[] => {
    const agent = participant.who.kind === 'session';
    let cursor = participant.cursor?.kind === 'doc' ? participant.cursor : null;
    if (!cursor && agent && participant.focus) {
      const anchor = threads.find((thread) => thread.thread_id === participant.focus)?.anchor;
      if (anchor?.type === 'text')
        cursor = { kind: 'doc', quote: clip(anchor.quote, 64), prefix: anchor.prefix, offset: 0 };
    }
    const selection = participant.selection?.kind === 'doc' ? participant.selection : null;
    if (!cursor && !selection) return [];
    return [
      {
        id: participant.id,
        name: participant.name,
        color: participant.color,
        agent,
        status: agent ? statusLabel(participant.status) : null,
        cursor: cursor ? { quote: cursor.quote, prefix: cursor.prefix, offset: cursor.offset } : null,
        selection: selection
          ? { quote: selection.quote, prefix: selection.prefix, suffix: selection.suffix }
          : null,
      },
    ];
  });
}

export interface DocLivePresence {
  /** This viewer's Markdown: every peer re-anchors in it. */
  markdown: string;
  peers: readonly DocLivePeer[];
}

/**
 * The label fades 3 s after the caret last moved (a moved caret is a new
 * widget, so the animation starts again) and shows again on hover. An agent's
 * label never fades: an agent moves rarely, and its place is the point.
 */
export const DOC_LIVE_CSS = `
@keyframes kx-live-label-out { to { opacity: 0 } }
.kx-live-label[data-fade] { animation: kx-live-label-out var(--duration-normal) var(--ease-out) 3s forwards }
.kx-live-caret:hover .kx-live-label { animation: none }
@media (prefers-reduced-motion: reduce) { .kx-live-label[data-fade] { animation-duration: 0s } }
`;

/** Phosphor's Robot (bold), the agent glyph of `EntityAvatar`: a widget is plain DOM, not React. */
const ROBOT_PATH =
  'M72,104a16,16,0,1,1,16,16A16,16,0,0,1,72,104Zm96,16a16,16,0,1,0-16-16A16,16,0,0,0,168,120Zm68-40V192a36,36,0,0,1-36,36H56a36,36,0,0,1-36-36V80A36,36,0,0,1,56,44h60V16a12,12,0,0,1,24,0V44h60A36,36,0,0,1,236,80Zm-24,0a12,12,0,0,0-12-12H56A12,12,0,0,0,44,80V192a12,12,0,0,0,12,12H200a12,12,0,0,0,12-12Zm-12,82a30,30,0,0,1-30,30H86a30,30,0,0,1,0-60h84A30,30,0,0,1,200,162Zm-80-6v12h16V156ZM86,168H96V156H86a6,6,0,0,0,0,12Zm90-6a6,6,0,0,0-6-6H160v12h10A6,6,0,0,0,176,162Z';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/**
 * A remote caret: a 2px line in the person's color (1px border each side of a
 * zero-width span, so it spans the text's height in any block), and the name
 * on the page surface above it. The name stays ink; the color is the line.
 */
function caret(peer: DocLivePeer): HTMLElement {
  const root = element(
    'span',
    `kx-live-caret group/live relative -mx-px border-x ${LIVE_BORDER[peer.color]} before:absolute before:-inset-x-1 before:inset-y-0`,
  );
  root.contentEditable = 'false';
  root.setAttribute('aria-hidden', 'true');
  root.dataset.liveCaret = peer.id;
  const label = element(
    'span',
    `kx-live-label bg-popover text-foreground pointer-events-none absolute bottom-full -left-px z-10 flex items-center gap-1 rounded-sm border-l-2 ${LIVE_BORDER[peer.color]} px-1.5 text-xs leading-5 font-medium whitespace-nowrap shadow-md select-none`,
  );
  if (!peer.agent) label.dataset.fade = '';
  if (peer.agent) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('class', 'text-muted-foreground size-3 shrink-0');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ROBOT_PATH);
    svg.append(path);
    label.append(svg);
  }
  const name = element('span', 'max-w-48 truncate');
  name.textContent = peer.name;
  label.append(name);
  if (peer.status) {
    const status = element('span', 'text-muted-foreground font-normal');
    status.textContent = `· ${peer.status}`;
    label.append(status);
  }
  root.append(label);
  return root;
}

/** The decorations of one presence frame: selections first (under), then carets. */
export function docLiveDecorations(input: DocLivePresence, doc: Parameters<typeof DecorationSet.create>[0]) {
  const map = cachedDocMarkdownPositions(input.markdown, doc);
  if (!map) return DecorationSet.empty;
  // One re-anchoring budget per pass, split per participant: one crafted quote cannot
  // freeze the tab or hide the other carets.
  const budgetFor = createArtifactReanchorBudgets(input.peers.map((peer) => peer.id));
  const decorations: Decoration[] = [];
  const size = doc.content.size;
  for (const peer of input.peers) {
    const budget = budgetFor(peer.id);
    if (peer.selection) {
      const span = resolveDocLiveRange(input.markdown, peer.selection, budget);
      if (span)
        for (const range of docRangesForSource(map, span.start, span.end))
          decorations.push(
            Decoration.inline(range.from, range.to, {
              class: LIVE_TINT[peer.color],
              'data-live-selection': peer.id,
            }),
          );
    }
    if (peer.cursor) {
      const offset = resolveDocLiveCursor(input.markdown, peer.cursor, budget);
      const pos = offset === null ? null : docPositionForSource(map, offset);
      if (pos !== null && pos >= 0 && pos <= size)
        decorations.push(
          Decoration.widget(pos, () => caret(peer), {
            // Equal keys keep the DOM (and its fade); a move or a rename draws it again.
            key: JSON.stringify([peer.id, peer.name, peer.color, peer.status, peer.cursor]),
            side: 1,
            ignoreSelection: true,
          }),
        );
    }
  }
  return DecorationSet.create(doc, decorations);
}

export function createDocLivePlugin(): Plugin<DecorationSet> {
  return new Plugin({
    key: docLivePluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, decorations) {
        const input = transaction.getMeta(docLivePluginKey) as DocLivePresence | undefined;
        // Between frames, local edits move the carets with the text.
        if (!input) return decorations.map(transaction.mapping, transaction.doc);
        return docLiveDecorations(input, transaction.doc);
      },
    },
    props: {
      decorations: (state) => docLivePluginKey.getState(state) ?? DecorationSet.empty,
    },
  });
}

export const DocLiveDecorations = Extension.create({
  name: 'artifactDocLive',
  addProseMirrorPlugins() {
    return [createDocLivePlugin()];
  },
});
