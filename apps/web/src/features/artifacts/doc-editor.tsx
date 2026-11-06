'use client';

import {
  getArtifact,
  getArtifactDoc,
  getLinkPreview,
  listArtifactActivity,
  readArtifactFile,
  type ArtifactCommentSnapshot,
  type ArtifactCommentThread,
  type ArtifactDetail,
  type ArtifactLiveParticipant,
  type ArtifactLivePosition,
  type ArtifactLiveRange,
  type ArtifactLiveStatus,
} from '@kortix/sdk';
import { useArtifactMutations, useArtifactText } from '@kortix/sdk/react';
import { ARTIFACT_TEXT_QUOTE_MAX, type ArtifactTextAnchor } from '@kortix/shared/artifact-comments';
import { ARTIFACT_DOC_CSS } from '@kortix/shared/artifact-doc';
import { canEmbed, fetchEmbed } from '@kortix/ui/markdown/doc-editor/doc-embed';
import { docExtensions } from '@kortix/ui/markdown/doc-editor/doc-extensions';
import { DocMenus } from '@kortix/ui/markdown/doc-editor/doc-menus';
import { docRoundTrips, htmlToMarkdown, markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';
import { Button } from '@kortix/ui/button';
import { ButtonGroup } from '@kortix/ui/button-group';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { ErrorState } from '@kortix/ui/error-state';
import { InfoBanner } from '@kortix/ui/info-banner';
import Loading from '@kortix/ui/loading';
import { MENU_PANEL_STATIC, menuRow } from '@kortix/ui/menu-recipe';
import { errorToast, infoToast } from '@kortix/ui/toast';
import { CardsIcon, LinkSimpleIcon, WarningIcon } from '@phosphor-icons/react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { createPacedSender, createTypingSignal } from './artifact-live-logic';
import { createDocSaver, pendingSave, type DocSaveStatus, type DocSaver, type Known } from './doc-autosave';
import {
  CoeditUnavailable,
  createDocCoedit,
  waitForSeed,
  type CoeditFallback,
  type DocCoeditSession,
  type DocPings,
} from './doc-coedit';
import {
  CoeditNote,
  fallbackNote,
  guardNote,
  liveBridge,
  liveExtensions,
  seedUpdate,
  type CoeditNoteReason,
} from './doc-coedit-editor';
import { captureDocComment } from './doc-comment-capture';
import {
  DocCommentDecorations,
  docCommentPluginKey,
  scrollDocCommentHighlight,
  type DocCommentHighlights,
} from './doc-comment-decorations';
import { docMarkdownPositions, docSelectionAnchor } from './doc-comment-positions';
import {
  DOC_LIVE_CSS,
  DocLiveDecorations,
  docLivePeers,
  docLivePluginKey,
  type DocLivePresence,
} from './doc-live-decorations';
import {
  cachedDocMarkdownPositions,
  docLiveCursor,
  docLiveRange,
  docSourceOffset,
} from './doc-live-positions';
import { fileBase64, isMedia, mediaPath, mediaUrls, tooLarge } from './doc-media';
import { SlashCommand, SlashMenu, type SlashState } from './doc-slash-menu';

import { useTranslations } from '@/i18n/use-translations';

export type { DocSaveStatus };

const isConflict = (err: unknown) =>
  (err as { status?: number }).status === 409 &&
  (err as { code?: string }).code === 'version_conflict';
const NO_COMMENTS: readonly ArtifactCommentThread[] = [];
/** A co-edited doc that has not loaded by then opens with autosave instead. */
const COEDIT_START_MS = 10_000;

/**
 * What the editor opened on. `live`: co-edited (KRTX-3670), the editor binds
 * to the session's `Y.Doc` and autosave is off. Otherwise `html` loads into a
 * single-writer editor; `note` says why co-editing is off, `dirty` that the
 * editor holds text the file lacks (co-editing stopped mid-way).
 */
type Loaded = {
  html: string;
  start: Known;
  live?: DocCoeditSession;
  note?: CoeditNoteReason;
  dirty?: boolean;
  /** A read-only viewer of a doc nobody seeded yet: it goes live once someone does. */
  unseeded?: boolean;
};

/**
 * Live presence in the doc (KRTX-3669): the others' carets and selections,
 * and this viewer's own, sent while the editor has focus.
 */
export interface DocLiveBinding {
  /** Everyone else on the doc view, agents included; never this viewer, never a hidden one. */
  peers: readonly ArtifactLiveParticipant[];
  /** An agent's status in words ("Editing"). */
  statusLabel: (status: ArtifactLiveStatus) => string;
  /** This viewer hides their cursor ("Hide my cursor", or the tab is in the background). */
  hidden: boolean;
  setCursor: (at: ArtifactLivePosition | null) => void;
  setSelection: (range: ArtifactLiveRange | null) => void;
  /** Typing in the doc itself; false after 2 s without an edit. */
  setTyping: (active: boolean) => void;
}

type OwnPlace = { cursor: ArtifactLivePosition | null; selection: ArtifactLiveRange | null };
const NOWHERE: OwnPlace = { cursor: null, selection: null };

/** The page's text selection lies in the editor (a read-only doc never takes focus). */
function selectionInside(editor: Editor): boolean {
  let root: HTMLElement;
  try {
    // An editor that is not mounted yet has no DOM: TipTap throws on `view.dom`.
    root = editor.view.dom;
  } catch {
    return false;
  }
  const selection = root.ownerDocument.getSelection();
  return !!selection && selection.rangeCount > 0 && root.contains(selection.anchorNode);
}

/**
 * A doc artifact, edited in place: its Markdown file in Files, shown with the
 * same stylesheet the published page uses. Markdown shortcuts (`# `, `- `,
 * `1. `, `[ ] `, `> `, ``` ```), a menu on selected text, a `/` block menu,
 * tables, task lists, links, images, and GitHub or Linear links as cards
 * (a pasted one offers the card).
 *
 * Changes save themselves back to the file; each save is a commit of the Files
 * volume (`doc-autosave.ts` has the rules).
 *
 * With `coedit` (the `artifact_comments` flag, the current version), a doc
 * whose Markdown survives the editor byte for byte (`docRoundTrips`, at most
 * 1 MiB) is co-edited live: everyone's text appears as they type, and the tab
 * that holds the lease writes the file (`doc-coedit.ts` has the rules). A
 * read-only viewer sees the live text. Any other doc keeps autosave, with a
 * one-line note for an editor.
 */
export function DocEditor({
  projectId,
  artifact,
  editable: mayEdit,
  onStatus,
  onReload,
  comments = NO_COMMENTS,
  focusedThreadId,
  focusRevision,
  onFocusThread,
  canComment = false,
  onComment,
  onCommentStart,
  historical = false,
  readCommentSnapshot,
  commentEntryVersion,
  live,
  onReady,
  coedit,
}: {
  projectId: string;
  artifact: ArtifactDetail;
  editable: boolean;
  onStatus: (status: DocSaveStatus) => void;
  /** Open the doc again at its current version (the conflict's Reload). */
  onReload: () => void;
  comments?: readonly ArtifactCommentThread[];
  focusedThreadId?: string | null;
  focusRevision?: number;
  onFocusThread?: (threadId: string) => void;
  canComment?: boolean;
  onComment?: (anchor: ArtifactTextAnchor) => void;
  onCommentStart?: () => () => void;
  historical?: boolean;
  readCommentSnapshot?: () => Promise<ArtifactCommentSnapshot>;
  commentEntryVersion?: string | null;
  /** Live presence; absent while the Artifact's live connection is off. */
  live?: DocLiveBinding;
  /** The doc's text is on screen (once per editor): the viewer restores its scroll position. */
  onReady?: () => void;
  /**
   * Live co-editing: the viewer's `changed doc` pings. Set while the flag is
   * on and this is the current version (never on a historical one).
   */
  coedit?: DocPings;
}) {
  const t = useTranslations('artifacts');
  const editable = mayEdit && !historical;
  const { save: saveMutation } = useArtifactMutations(projectId);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const liveSession = loaded?.live ?? null;
  const saver = useRef<DocSaver | null>(null);
  // Another writer changed the file under unsaved edits: autosave waits for the person's choice,
  // shown above the doc until they make it (a toast could be closed and take the choice with it).
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const sourceMarkdown = useRef('');
  /**
   * A read-only editor with co-editing on stays mounted across file versions (the viewer keys it
   * so) and shows the file it last read: this one.
   */
  const shownFile = useRef<Known | null>(null);
  const [revision, setRevision] = useState(0);
  const [commenting, setCommenting] = useState(false);
  const commentCapture = useRef<{ cancel: () => void } | null>(null);
  const latest = useRef({
    save: saveMutation,
    onStatus,
    onReload,
    artifact,
    t,
    onFocusThread,
    onComment,
    onCommentStart,
    readCommentSnapshot,
    canComment,
    historical,
    live,
    onReady,
    coedited: false,
  });
  useLayoutEffect(() => {
    latest.current = {
      save: saveMutation,
      onStatus,
      onReload,
      artifact,
      t,
      onFocusThread,
      onComment,
      onCommentStart,
      readCommentSnapshot,
      canComment,
      historical,
      live,
      onReady,
      coedited: !!liveSession,
    };
  });
  // eslint-disable-next-line react-hooks/refs -- configure stores this callback; editor events read the ref after render.
  const [commentExtension] = useState(() =>
    DocCommentDecorations.configure({ onFocus: (id) => latest.current.onFocusThread?.(id) }),
  );
  // Relative media paths in the Markdown ↔ absolute URLs in the editor (the page URL of this version).
  const [media] = useState(() => mediaUrls(artifact.version.view_url));
  /** Single-file docs serve only themselves: their media must be absolute URLs. */
  const holdsMedia = !artifact.path.endsWith(`/${artifact.entry}`);

  // A save from a closed editor of this doc still on its way: wait for it (undefined), then open on it.
  const [pendingHandoff] = useState(() => pendingSave(artifact.artifact_id));
  const [handoff, setHandoff] = useState<Known | null | undefined>(
    pendingHandoff ? undefined : null,
  );
  useEffect(() => {
    if (!pendingHandoff) return;
    let live = true;
    void pendingHandoff.then((result) => live && setHandoff(result));
    return () => {
      live = false;
    };
  }, [pendingHandoff]);

  // Usually already in the cache (prefetched by the project preloader or a hover).
  // Pinned to the version opened: our own saves move `entry_version` and must not refetch.
  const [opened] = useState(artifact);
  const text = useArtifactText(projectId, handoff === null ? opened : null);
  const start: Known | null =
    handoff ??
    (handoff === null && text.data !== undefined
      ? { version: opened.entry_version, text: text.data }
      : null);
  // Co-editing needs the flag, the current version, a versioned file, and a byte-for-byte round trip.
  const coeditWanted = !!coedit && !historical;
  const guard = start && coeditWanted ? docRoundTrips(start.text) : null;
  const coeditable = !!start && start.version !== null && !!guard?.ok;
  if (loaded === null && start && !coeditable)
    setLoaded({
      html: media.resolveHtml(markdownToHtml(start.text)),
      start,
      note: guard && !guard.ok && editable ? guardNote(guard) : undefined,
    });
  // The text did not load: the doc area says so and offers a retry (below), never a spinner forever.
  const textFailed = loaded === null && handoff === null && text.isError;
  useEffect(() => {
    if (loaded) sourceMarkdown.current = loaded.start.text;
  }, [loaded]);

  const markdownOf = (editor: Editor) => htmlToMarkdown(media.restore(editor.getHTML()));
  const readNow = async (current: ArtifactDetail): Promise<Known> => {
    const [detail, file] = await Promise.all([
      getArtifact(projectId, current.artifact_id),
      readArtifactFile(projectId, current.artifact_id),
    ]);
    return { version: detail.entry_version, text: await file.text() };
  };

  const writeEntry = async (current: ArtifactDetail, markdown: string, base: string | null) => {
    const next = await latest.current.save.mutateAsync({
      artifactId: current.artifact_id,
      ...(base ? { base_version: base } : {}),
      files: { [current.entry]: { content: markdown } },
    });
    return next.entry_version;
  };

  /**
   * Co-editing stopped mid-way (a 413, the doc's history over its cap, or a
   * refusal the engine cannot retry): reopen with autosave on what the editor
   * holds now, from the file this tab last knew. A save on top of a newer
   * file meets today's conflict choice. A read-only viewer whose doc was reset
   * and not seeded again shows the file until it is (`unseeded`).
   */
  const leaveLive = (session: DocCoeditSession, reason: CoeditFallback) => {
    const known = session.known();
    const text = session.markdown() ?? known.text;
    session.close();
    setLoaded({
      html: media.resolveHtml(markdownToHtml(text)),
      start: known,
      note: editable ? fallbackNote(reason) : undefined,
      dirty: editable && text !== known.text,
      unseeded: reason === 'unseeded',
    });
  };
  const leaveLiveRef = useRef(leaveLive);
  useEffect(() => {
    leaveLiveRef.current = leaveLive;
  });

  /**
   * A reset loaded the doc again on a fresh `Y.Doc`: a new editor binds to it
   * (`loaded` changes). The session puts the caret and focus back once it is
   * attached (`liveBridge`); the viewer restores the scroll position of each
   * new editor (`onReady`).
   */
  const rebind = () => setLoaded((prev) => (prev?.live ? { ...prev } : prev));

  /**
   * Co-editing: load (or seed) the shared doc, then open the editor on it.
   * `onSolo`: it did not load within COEDIT_START_MS or was refused (`note`),
   * or nobody seeded it yet and this viewer may not (`unseeded`). Returns the
   * cancel; once the editor opened on the session, the `liveSession` effect
   * closes it instead.
   */
  const openLive = (opened: Known, onSolo: (outcome: { note?: CoeditNoteReason; unseeded?: boolean }) => void) => {
    const current = latest.current.artifact;
    const schema = docExtensions({ editable, placeholder: () => '' });
    let adopted = false;
    let over = false;
    const session = createDocCoedit({
      projectId,
      artifactId: current.artifact_id,
      holder: crypto.randomUUID(),
      readOnly: !editable,
      opened,
      seed: (markdown) => seedUpdate(markdown, schema),
      write: (markdown, base) => writeEntry(current, markdown, base),
      read: () => readNow(current),
      isConflict,
      // A restore records itself in Activity; a Files mount heal does not.
      restores: async () =>
        (await listArtifactActivity(projectId, current.artifact_id, { limit: 20 })).items
          .filter((item) => item.type === 'restored')
          .map((item) => item.id),
      onStatus: (status) => {
        if (adopted && editable) latest.current.onStatus(status);
      },
      onFallback: (reason) => {
        if (adopted) leaveLiveRef.current(session, reason);
      },
      onRebind: rebind,
      // A read-only viewer waits for an editor to seed the doc again after a reset.
      seeded: async () =>
        (await getArtifactDoc(projectId, current.artifact_id, { after: Number.MAX_SAFE_INTEGER })).seeded,
    });
    const solo = (outcome: { note?: CoeditNoteReason; unseeded?: boolean }) => {
      if (over) return;
      over = true;
      window.clearTimeout(timer);
      session.close();
      onSolo(outcome);
    };
    const timer = window.setTimeout(() => solo({ note: 'off-failed' }), COEDIT_START_MS);
    session.start().then(
      () => {
        if (over) return;
        over = true;
        adopted = true;
        window.clearTimeout(timer);
        setLoaded({ html: '', start: opened, live: session });
      },
      (err: unknown) => solo(err instanceof CoeditUnavailable ? { unseeded: true } : { note: 'off-failed' }),
    );
    return () => {
      if (adopted) return;
      over = true;
      window.clearTimeout(timer);
      session.close();
    };
  };

  // Open the doc live when it may be co-edited. A doc that does not load opens with autosave and a
  // note; a read-only viewer of a doc nobody seeded yet sees the file, without a note, until it is.
  const startText = coeditable ? start?.text : undefined;
  const startVersion = coeditable ? start?.version : undefined;
  useEffect(() => {
    if (loaded !== null || startText === undefined || !startVersion) return;
    const opened: Known = { version: startVersion, text: startText };
    return openLive(opened, ({ note, unseeded }) =>
      setLoaded({
        html: media.resolveHtml(markdownToHtml(opened.text)),
        start: opened,
        note: editable ? note : undefined,
        unseeded,
      }),
    );
    // Once per opened file: `loaded` changing to this session must not cancel it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startText, startVersion]);

  // A read-only viewer of a doc nobody seeded goes live, without a reload, once an editor seeds it.
  useEffect(() => {
    if (!loaded?.unseeded) return;
    const current = latest.current.artifact;
    const shown = shownFile.current ?? loaded.start;
    let cancel: (() => void) | null = null;
    const stop = waitForSeed({
      seeded: async () =>
        (await getArtifactDoc(projectId, current.artifact_id, { after: Number.MAX_SAFE_INTEGER })).seeded,
      // A refusal now keeps the file on screen as it is.
      onSeeded: () => {
        cancel = openLive(shown, () => {});
      },
    });
    return () => {
      stop();
      cancel?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // The session the editor opened on closes when the editor leaves it: unmount, a fallback, a Reload.
  useEffect(() => {
    if (!liveSession) return;
    return () => liveSession.close();
  }, [liveSession]);

  const showConflict = () => setConflict(true);
  const keepMine = () => {
    setConflict(false);
    saver.current?.keepMine();
  };

  /**
   * Pasted, dropped or picked images and videos: shown at once from a local
   * URL with an "Uploading…" chip, written next to the doc in Files
   * (`media/…`), then pointed at that file. A failed upload removes it.
   */
  const upload = async (editor: Editor, files: File[], pos?: number) => {
    const { save: run, onStatus: report, artifact: current } = latest.current;
    const picked = files.flatMap((file) => {
      const kind = isMedia(file);
      return kind ? [{ file, kind }] : [];
    });
    if (!picked.length) return;
    if (!holdsMedia) return errorToast(t('mediaSingleFile'));
    const placed = picked.flatMap(({ file, kind }) => {
      if (!tooLarge(file)) return [{ file, kind, local: URL.createObjectURL(file) }];
      errorToast(t('mediaTooLarge'));
      return [];
    });
    if (!placed.length) return;
    editor
      .chain()
      .focus()
      .insertContentAt(
        pos ?? editor.state.selection.to,
        placed.map(({ kind, local }) => ({ type: kind, attrs: { src: local, uploading: true } })),
      )
      .run();
    // Co-edited: the "Uploading…" chip is the status; the doc's text syncs on its own.
    const coedited = latest.current.coedited;
    for (const { file, kind, local } of placed) {
      const path = mediaPath(file);
      if (!coedited) report('saving');
      let src: string | null = null;
      try {
        await run.mutateAsync({
          artifactId: current.artifact_id,
          files: { [path]: { content_base64: await fileBase64(file) } },
        });
        // The shared doc of a co-edited doc holds the file's own relative path; the editor resolves it.
        src = coedited ? path : media.absolute(path);
        // Swap to the uploaded file once it has loaded, so the picture does not blink.
        if (kind === 'image') await preload(media.absolute(path));
      } catch {
        // The API client toasts the error; the doc's own text is unaffected.
        if (!coedited) report(saver.current?.busy() ? 'unsaved' : 'saved');
      }
      if (!editor.isDestroyed) replaceMedia(editor, local, src);
      URL.revokeObjectURL(local);
    }
  };
  const uploadRef = useRef(upload);
  useEffect(() => {
    uploadRef.current = upload;
  });

  const [slash, setSlash] = useState<SlashState | null>(null);
  const slashKeys = useRef<(event: KeyboardEvent) => boolean>(() => false);
  // eslint-disable-next-line react-hooks/refs -- configure stores this callback; slash-menu events read the ref after render.
  const [slashExtension] = useState(() =>
    SlashCommand.configure({ onChange: setSlash, onKey: (event) => slashKeys.current(event) }),
  );
  /** A GitHub or Linear link just pasted: the offer to show it as a card. */
  const [offer, setOffer] = useState<Offer | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable,
      extensions: [
        ...(() => {
          const base = docExtensions({
            editable,
            // None in a code block: it would sit on the block's language caption.
            placeholder: (node) =>
              node.type.name === 'codeBlock' ? '' : node.type.name === 'heading' ? t('placeholderHeading') : t('placeholder'),
          });
          // Co-edited: bound to the shared doc, which holds the file's relative media paths.
          return liveSession ? liveExtensions(base, { doc: liveSession.doc, resolveSrc: media.absolute.bind(media) }) : base;
        })(),
        commentExtension,
        DocLiveDecorations,
        slashExtension,
      ],
      // A co-edited editor takes its content from the shared doc.
      ...(liveSession ? {} : { content: loaded?.html ?? '' }),
      editorProps: {
        handlePaste: (view, event) => {
          const ed = editorRef.current;
          if (!editable || !ed) return false;
          const files = Array.from(event.clipboardData?.files ?? []).filter(isMedia);
          if (files.length) {
            void uploadRef.current(ed, files);
            return true;
          }
          // A lone link on an empty selection: paste it as a link, then offer the card.
          const href = event.clipboardData?.getData('text/plain').trim() ?? '';
          const { selection } = view.state;
          if (
            !canEmbed(href) ||
            /\s/.test(href) ||
            !selection.empty ||
            selection.$from.parent.type.spec.code
          )
            return false;
          ed.chain()
            .focus()
            .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
            .run();
          setOffer({ from: selection.from, to: selection.from + href.length, href });
          return true;
        },
        handleDrop: (view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []).filter(isMedia);
          if (!editable || !files.length) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          const ed = editorRef.current;
          if (ed) void uploadRef.current(ed, files, at);
          return true;
        },
      },
      onUpdate: ({ editor: updated }) => {
        // A co-edited doc also changes under a read-only viewer: others' text arrives.
        if (editable || liveSession) {
          sourceMarkdown.current = markdownOf(updated);
          setRevision((value) => value + 1);
          if (!liveSession) saver.current?.edited();
        }
      },
    },
    [loaded, editable],
  );
  const editorRef = useRef<Editor | null>(null);
  const handledFocus = useRef('');
  useEffect(() => {
    editorRef.current = editor;
    handledFocus.current = '';
    return () => {
      if (editorRef.current === editor) {
        editorRef.current = null;
        commentCapture.current?.cancel();
        commentCapture.current = null;
      }
    };
  }, [editor]);

  // Co-editing: the leader's duties need the mounted editor (its Markdown, the outside-edit merge).
  // Binding renders the shared doc, which may be ahead of the file it opened on, as one update:
  // `onUpdate` anchors comments and carets in that text.
  // The render that adopts the session still holds the editor it replaces (already destroyed).
  useEffect(() => {
    if (!editor || editor.isDestroyed || !liveSession) return;
    return liveSession.attach(liveBridge(editor));
  }, [editor, liveSession]);

  // Co-editing: `changed doc` pings pull at once; the page going away sends what is unsent and
  // releases the lease; back from the back-forward cache, the doc opens again. ⌘S writes now (the
  // leader); leaving warns while an edit is not safe yet.
  const pings = coedit;
  useEffect(() => {
    if (!liveSession) return;
    const unsubscribe = pings?.subscribe((seq) => liveSession.notify(seq));
    const onHide = () => liveSession.close();
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) latest.current.onReload();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void liveSession.flushNow();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (liveSession.busy()) e.preventDefault();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    if (editable) {
      window.addEventListener('keydown', onKey);
      window.addEventListener('beforeunload', onLeave);
    }
    return () => {
      unsubscribe?.();
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [liveSession, pings, editable]);
  useEffect(() => {
    // The render that switches what the editor opened on (live ↔ autosave) still holds the old, destroyed editor.
    if (!editor || editor.isDestroyed || !loaded) return;
    const highlights: DocCommentHighlights = {
      markdown: sourceMarkdown.current,
      comments,
      focusedThreadId,
      version: historical ? artifact.version.id : undefined,
      entryVersion: historical ? commentEntryVersion : undefined,
      label: t('discussion.commentSelection'),
      focusable: !editable,
    };
    editor.view.dispatch(editor.state.tr.setMeta(docCommentPluginKey, highlights));
  }, [
    editor,
    loaded,
    comments,
    focusedThreadId,
    historical,
    editable,
    artifact.version.id,
    commentEntryVersion,
    revision,
    t,
  ]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    handledFocus.current = scrollDocCommentHighlight(
      editor.view.dom,
      focusedThreadId,
      focusRevision,
      handledFocus.current,
    );
  }, [editor, focusedThreadId, focusRevision, comments, commentEntryVersion, revision]);

  // The text is on screen: once per editor.
  useEffect(() => {
    if (editor && loaded) latest.current.onReady?.();
  }, [editor, loaded]);

  // Live: the others' carets and selections, drawn again when a frame changes what to draw.
  // Between frames, local edits move them with the text (the plugin maps its decorations).
  const livePeers = live?.peers;
  const statusLabel = live?.statusLabel;
  const presence = useMemo(
    () => (livePeers && statusLabel ? docLivePeers(livePeers, comments, statusLabel) : []),
    [livePeers, comments, statusLabel],
  );
  const presenceKey = JSON.stringify(presence);
  useEffect(() => {
    if (!editor || !loaded || editor.isDestroyed) return;
    const input: DocLivePresence = { markdown: sourceMarkdown.current, peers: presence };
    editor.view.dispatch(editor.state.tr.setMeta(docLivePluginKey, input));
    // `presence` is rebuilt each render; its key says whether it changed. A revision (an edit,
    // or new text from the file) re-anchors everyone in the new Markdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, loaded, presenceKey, revision]);

  // Live: this viewer's own caret and selection, paced, only while the editor has focus (a
  // read-only doc: while the page's selection is in it); typing in the doc, until 2 s idle.
  const liveOn = !!live;
  const liveHidden = live?.hidden ?? false;
  const ownLive = useRef<{ report: () => void } | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed || !loaded || !liveOn) return;
    const sender = createPacedSender<OwnPlace>((place) => {
      latest.current.live?.setCursor(place.cursor);
      latest.current.live?.setSelection(place.selection);
    });
    const typing = createTypingSignal((active) => latest.current.live?.setTyping(active));
    const own = (): OwnPlace => {
      const binding = latest.current.live;
      if (!binding || binding.hidden || editor.isDestroyed) return NOWHERE;
      if (editable ? !editor.isFocused : !selectionInside(editor)) return NOWHERE;
      const markdown = sourceMarkdown.current;
      const map = cachedDocMarkdownPositions(markdown, editor.state.doc);
      const { from, to, head, empty } = editor.state.selection;
      // A read-only doc has no caret to show: only what the person selects.
      const caret = editable ? docSourceOffset(map, head) : null;
      const start = empty ? null : docSourceOffset(map, from);
      const end = empty ? null : docSourceOffset(map, to);
      return {
        cursor: caret === null ? null : docLiveCursor(markdown, caret),
        selection: start === null || end === null ? null : docLiveRange(markdown, start, end),
      };
    };
    const report = () => sender.push(own());
    const leave = () => {
      typing.stop();
      sender.push(NOWHERE);
      sender.flush();
    };
    const onUpdate = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (editable && transaction.docChanged && editor.isFocused && !latest.current.live?.hidden)
        typing.input();
      report();
    };
    ownLive.current = { report };
    editor.on('selectionUpdate', report);
    editor.on('focus', report);
    editor.on('blur', leave);
    editor.on('update', onUpdate);
    // A read-only doc never focuses: its selection leaving the doc is a page event.
    const doc = window.document;
    if (!editable) doc.addEventListener('selectionchange', report);
    report();
    return () => {
      editor.off('selectionUpdate', report);
      editor.off('focus', report);
      editor.off('blur', leave);
      editor.off('update', onUpdate);
      doc.removeEventListener('selectionchange', report);
      if (ownLive.current?.report === report) ownLive.current = null;
      leave();
      sender.dispose();
    };
  }, [editor, loaded, liveOn, editable]);
  // Hiding sends "nowhere" (the server forgets a hidden caret); showing again sends the caret.
  useEffect(() => {
    ownLive.current?.report();
  }, [liveHidden]);

  // A passage longer than a quote can hold is refused with the limit, never cut.
  const selectionError = (error: 'unmapped' | 'ambiguous' | 'too_long') =>
    error === 'too_long'
      ? t('discussion.selectionTooLong', { max: ARTIFACT_TEXT_QUOTE_MAX })
      : t('discussion.selectionUnavailable');
  const commentSelection = async () => {
    const current = editorRef.current;
    const context = latest.current;
    if (
      !current ||
      !loaded ||
      commenting ||
      commentCapture.current ||
      !context.canComment ||
      context.historical ||
      !context.onComment ||
      !context.readCommentSnapshot
    )
      return;
    const document = current.state.doc;
    const { from, to } = current.state.selection;
    const readSnapshot = context.readCommentSnapshot;
    setCommenting(true);
    let operation: ReturnType<typeof captureDocComment<ArtifactTextAnchor>> | undefined;
    try {
      operation = captureDocComment(
        context.onCommentStart,
        async () => {
          const candidate = docSelectionAnchor(
            docMarkdownPositions(sourceMarkdown.current, document),
            from,
            to,
            'pending',
          );
          if ('error' in candidate) {
            errorToast(selectionError(candidate.error));
            return;
          }
          let saved: Known;
          try {
            saved = loaded.live
              ? await loaded.live.snapshot()
              : editable
                ? await saver.current!.snapshot()
                : (shownFile.current ?? loaded.start);
          } catch {
            errorToast(t('discussion.commentSaveFailed'));
            return;
          }
          if (editorRef.current !== current || current.isDestroyed) return;
          const snapshot = await readSnapshot();
          if (editorRef.current !== current || current.isDestroyed) return;
          if (
            snapshot.text !== saved.text ||
            editorRef.current !== current ||
            current.state.doc !== document ||
            current.state.selection.from !== from ||
            current.state.selection.to !== to ||
            latest.current.historical ||
            !latest.current.canComment
          ) {
            errorToast(t('discussion.snapshotChanged'));
            return;
          }
          const result = docSelectionAnchor(
            docMarkdownPositions(saved.text, document),
            from,
            to,
            snapshot.version,
          );
          if ('error' in result) errorToast(selectionError(result.error));
          else return result.anchor;
        },
        (anchor) => {
          latest.current.onComment?.(anchor);
          // The passage now lives in the composer: collapse the selection so the formatting bubble hides.
          if (editorRef.current === current && !current.isDestroyed) current.commands.setTextSelection(to);
        },
      );
      commentCapture.current = operation;
      await operation.done;
    } catch {
      if (editorRef.current === current && !current.isDestroyed) errorToast(t('discussion.snapshotChanged'));
    } finally {
      if (commentCapture.current === operation) commentCapture.current = null;
      setCommenting(false);
    }
  };

  // The file moved (an agent wrote it, the artifact says so): an editor with nothing unsaved shows the new text.
  const fileVersion = artifact.entry_version;
  useEffect(() => {
    // Co-edited: only the leader looks (an outside edit is merged into the live doc).
    if (liveSession) return liveSession.fileMoved(fileVersion);
    const shown = shownFile.current ?? loaded?.start;
    if (editor && !editable && coedit && loaded && fileVersion !== shown?.version) {
      let live = true;
      void readNow(latest.current.artifact).then(
        (now) => {
          if (!live || editor.isDestroyed || now.text === sourceMarkdown.current) return;
          shownFile.current = now;
          sourceMarkdown.current = now.text;
          editor.commands.setContent(media.resolveHtml(markdownToHtml(now.text)), { emitUpdate: false });
          setRevision((value) => value + 1);
        },
        () => {},
      );
      return () => {
        live = false;
      };
    }
    const docSaver = saver.current;
    if (!editor || !docSaver) return;
    let live = true;
    void docSaver.refresh(fileVersion).then((now) => {
      if (!live || !now || editor.isDestroyed) return;
      sourceMarkdown.current = now.text;
      editor.commands.setContent(media.resolveHtml(markdownToHtml(now.text)), {
        emitUpdate: false,
      });
      setRevision((value) => value + 1);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileVersion]);

  // One saver per editor; save now on ⌘S, warn before the page goes away with changes not in the file.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !editable || !loaded || loaded.live) return;
    const current = latest.current.artifact;
    const docSaver = createDocSaver(loaded.start, {
      artifactId: current.artifact_id,
      write: (markdown, base) => writeEntry(current, markdown, base),
      read: () => readNow(current),
      text: () => markdownOf(editor),
      onStatus: (status) => latest.current.onStatus(status),
      onConflict: showConflict,
      isConflict,
    });
    saver.current = docSaver;
    // Co-editing stopped with text the file lacks: save it (a newer file meets the conflict choice).
    if (loaded.dirty) docSaver.edited();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        docSaver.flush();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (docSaver.busy()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
      setConflict(false);
      docSaver.close();
      if (saver.current === docSaver) saver.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editable, loaded]);

  return (
    <div className="kx-doc min-h-full">
      <style>{ARTIFACT_DOC_CSS}</style>
      {live ? <style>{DOC_LIVE_CSS}</style> : null}
      {textFailed ? (
        <div className="grid min-h-60 place-items-center">
          <ErrorState
            size="sm"
            title={t('docLoadError')}
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={text.isFetching}
                onClick={() => void text.refetch()}
              >
                {text.isFetching ? <Loading className="size-4 shrink-0" /> : null}
                {t('retry')}
              </Button>
            }
          />
        </div>
      ) : loaded === null || !editor ? (
        // One quiet spinner while the text loads (usually cached: no wait at all).
        <div className="grid min-h-60 place-items-center">
          <Loading className="size-4" />
        </div>
      ) : (
        <>
          {editable || (canComment && !historical) ? (
            <DocMenus
              editor={editor}
              blockMenu={false}
              editable={editable}
              canComment={canComment && !historical && !!onComment && !!readCommentSnapshot}
              commenting={commenting}
              onComment={() => void commentSelection()}
            />
          ) : null}
          {editable && slash ? (
            <SlashMenu
              editor={editor}
              state={slash}
              keysRef={slashKeys}
              onPickMedia={() => picker.current?.click()}
            />
          ) : null}
          {editable && offer ? (
            <EmbedOffer
              projectId={projectId}
              editor={editor}
              offer={offer}
              onClose={() => setOffer(null)}
            />
          ) : null}
          {loaded.note ? <CoeditNote reason={loaded.note} /> : null}
          {editable && conflict ? (
            // Pinned to the top of the doc while it scrolls: the choice stays in reach.
            <div className="bg-background sticky top-0 z-10 mb-6 pt-2">
              <InfoBanner
                tone="warning"
                icon={WarningIcon}
                title={t('conflictTitle')}
                action={
                  <ButtonGroup>
                    <Button size="xs" variant="outline" onClick={keepMine}>
                      {t('conflictKeepMine')}
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => setConfirmReload(true)}>
                      {t('conflictReload')}
                    </Button>
                  </ButtonGroup>
                }
              >
                {t('conflict')}
              </InfoBanner>
            </div>
          ) : null}
          <ConfirmDialog
            open={confirmReload && conflict}
            onOpenChange={setConfirmReload}
            title={t('conflictReloadTitle')}
            description={t('conflictReloadHint')}
            confirmLabel={t('conflictReload')}
            confirmVariant="destructive"
            onConfirm={() => {
              setConfirmReload(false);
              latest.current.onReload();
            }}
          />
          <EditorContent editor={editor} />
          <input
            ref={picker}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => {
              void upload(editor, Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </>
      )}
    </div>
  );
}

/** Resolves when the image at `src` has loaded or failed (5 s at most). */
function preload(src: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new window.Image();
    const done = () => resolve();
    img.onload = done;
    img.onerror = done;
    window.setTimeout(done, 5_000);
    img.src = src;
  });
}

/** The uploading media at `local`: pointed at its uploaded `src`, or removed (null). */
function replaceMedia(editor: Editor, local: string, src: string | null) {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    if (node.attrs.src === local) at = pos;
  });
  if (at < 0) return;
  const node = editor.state.doc.nodeAt(at)!;
  const tr = src
    ? editor.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, src, uploading: false })
    : editor.state.tr.delete(at, at + node.nodeSize);
  editor.view.dispatch(tr);
}

type Offer = { from: number; to: number; href: string };

/**
 * Under a pasted link: keep it as a link, or show it as a card. ↑ ↓ move
 * between the two, Enter picks, Escape keeps the link; those keys belong to
 * the menu while it is open (the caret stays put). Typing, clicking elsewhere
 * or scrolling keeps the link.
 */
function EmbedOffer({
  projectId,
  editor,
  offer,
  onClose,
}: {
  projectId: string;
  editor: Editor;
  offer: Offer;
  onClose: () => void;
}) {
  const t = useTranslations('artifacts');
  const [loading, setLoading] = useState(false);
  // 0: Keep as link, 1: Show embed (the default, the reason the menu opened).
  const [active, setActive] = useState(1);
  const activeRef = useRef(1);
  const choose = (i: number) => {
    activeRef.current = i;
    setActive(i);
  };
  const close = useRef(onClose);
  const pick = useRef<(choice: number) => void>(() => {});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const onTransaction = ({
      transaction,
    }: {
      transaction: { docChanged: boolean; selection: { from: number } };
    }) => {
      if (transaction.docChanged || transaction.selection.from !== offer.to) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const own = (run: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        run();
      };
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
        own(() => choose(activeRef.current === 0 ? 1 : 0));
      else if (e.key === 'Enter') own(() => pick.current(activeRef.current));
      else if (e.key === 'Escape') own(() => close.current());
    };
    const onScroll = () => close.current();
    editor.on('transaction', onTransaction);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      editor.off('transaction', onTransaction);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [editor, offer]);

  const embed = async () => {
    setLoading(true);
    const meta = await fetchEmbed(offer.href, (url) => getLinkPreview(projectId, url));
    // Closed while the preview loaded (Escape, typing, Keep as link): the link stays a link.
    if (!mounted.current) return;
    if (!meta) {
      infoToast(t('embedUnavailable'));
      close.current();
      return;
    }
    const { doc } = editor.state;
    // The link must still be where it was pasted.
    if (offer.to <= doc.content.size && doc.textBetween(offer.from, offer.to) === offer.href) {
      const $from = doc.resolve(offer.from);
      // A top-level paragraph that holds only the link becomes the card; otherwise the card splits it
      // (a list item must start with a paragraph).
      const alone =
        $from.depth === 1 &&
        $from.parent.type.name === 'paragraph' &&
        $from.parent.textContent.trim() === offer.href;
      const range = alone
        ? { from: $from.before(), to: $from.after() }
        : { from: offer.from, to: offer.to };
      editor.chain().focus().insertContentAt(range, { type: 'linkEmbed', attrs: meta }).run();
    }
    close.current();
  };
  useEffect(() => {
    close.current = onClose;
    pick.current = (choice) => (choice === 0 ? onClose() : void embed());
  });

  let at: { left: number; bottom: number };
  try {
    at = editor.view.coordsAtPos(offer.to);
  } catch {
    return null;
  }
  return createPortal(
    <div
      role="menu"
      aria-label={t('embedOffer')}
      style={{ top: at.bottom + 6, left: at.left }}
      onMouseDown={(e) => e.preventDefault()}
      className={`${MENU_PANEL_STATIC} fixed z-50 w-48`}
    >
      <button
        type="button"
        role="menuitem"
        data-highlighted={active === 0 ? '' : undefined}
        onMouseMove={() => choose(0)}
        className={menuRow('sm', 'default')}
        onClick={onClose}
      >
        <LinkSimpleIcon className="text-muted-foreground" /> {t('keepAsLink')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-highlighted={active === 1 ? '' : undefined}
        onMouseMove={() => choose(1)}
        className={menuRow('sm', 'default')}
        disabled={loading}
        aria-busy={loading}
        onClick={() => void embed()}
      >
        {loading ? <Loading className="size-4" /> : <CardsIcon className="text-muted-foreground" />}{' '}
        {t('showEmbed')}
      </button>
    </div>,
    document.body,
  );
}
