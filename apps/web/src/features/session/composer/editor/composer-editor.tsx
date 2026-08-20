'use client';

import { cn } from '@/lib/utils';
import type { Agent, Command, Session } from '@kortix/sdk/react';
import type { Editor, JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { EditorContent, useEditor } from '@tiptap/react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';

import { textToParagraphs } from '../composer-logic';
import { createMentionSuggestion } from '../menus/mention-controller';
import type { SlashAction } from '../menus/slash-actions';
import { SLASH_ACTIONS } from '../menus/slash-actions';
import { createSlashSuggestion } from '../menus/slash-controller';
import type { TrackedMention } from '../types';
import { baseExtensions } from './extensions';
import { MentionNode } from './mention-node';
import { serializeDocument } from './serialize';
import { createSuggestionExtension } from './suggestion';

export interface ComposerEditorHandle {
  /**
   * `commandName` is the `/` command chip leading the draft, if any — see
   * `editor/serialize.ts`. When it is set, `text` is that command's ARGUMENTS:
   * the chip contributes no text of its own, so no stripping is needed at the
   * call site.
   */
  getContent(): {
    text: string;
    mentions: TrackedMention[];
    commandName?: string;
    /** Where the command chip sat in `text` — display only. See `serialize.ts`. */
    commandSplit?: { before: string; after: string };
  };
  /**
   * `text` — not `markdown`, and there is nothing for markdown to become.
   * The schema is paragraphs, text, hard breaks and chips (extensions.ts):
   * no parser to interpret `**bold**`/`# heading` on the way in, and no mark
   * or list node for it to produce if there were. `**bold**` goes in as six
   * literal characters and comes back out as six literal characters.
   *
   * Always replaces the whole document. An earlier `'replace' | 'merge'`
   * mode existed here, but every production caller always passed
   * `'replace'` — merging (failed-send recovery, transcription append, the
   * question-lock restore) is computed up front by pure functions in
   * `composer-logic.ts` and written back with a plain replace, so this
   * never needed a second mode of its own. Removed as dead code.
   */
  setContent(text: string): void;
  /**
   * The JSON-content-aware counterpart to `getContent`/`setContent` — Task
   * 13. `getContent().mentions` is a ONE-WAY projection: it's derived by
   * walking the live document for `mention` atom nodes (`serialize.ts`) and
   * has no path back to those nodes from the returned `{ text, mentions }`
   * pair. A caller that snapshots via `getContent()` and later tries to
   * restore via `setContent(text)` therefore can never bring the mention
   * nodes back — `setContent` only ever builds plain paragraph text
   * (`textToParagraphs`, below), never atoms. `getDocument`/`setDocument`
   * round-trip the actual ProseMirror JSON, atoms included, which is what a
   * failed-send retry or a question-lock save/restore needs: the mentions
   * the user typed must survive the round trip, not flatten into `"@label"`
   * text that the next send's `<file_ref>`/`<agent_ref>`/`<session_ref>`
   * blocks (built from the STRUCTURED `mentions` array, not the text) would
   * then be missing entirely.
   */
  getDocument(): JSONContent;
  /**
   * Always replaces the whole document, same as `setContent`. A `mode`
   * parameter (`'replace' | 'merge'`) existed here too, mirroring
   * `setContent`'s — removed for the same reason: every production caller
   * always passed `'replace'`. Merging mention atoms into the existing
   * document is computed as a pure ProseMirror fragment concat by
   * `composer-logic.ts` (which is what keeps mention atoms intact through a
   * merge, unlike `setContent`'s `textToParagraphs`, which only ever knows
   * how to build plain text) and written back through this method.
   */
  setDocument(doc: JSONContent): void;
  /**
   * Insert literal text at the CURRENT cursor/selection — Task 13. The old
   * plain `<textarea>` gave this for free via `setRangeText`; nothing here
   * replaced it until now. `setContent`/`setDocument` cannot substitute:
   * both always replace the whole document and force-focus its end (see
   * those methods' own callers), which is correct for a whole-draft restore
   * but wrong for a single redirected keystroke — it would discard whatever
   * the user was mid-typing instead of inserting at their actual (possibly
   * mid-document) cursor position. This inserts inline, at the selection,
   * and does not move focus itself (the caller — `useComposerFocus`'s
   * `onTypeAhead` — has already focused the element via the DOM before this
   * fires, so the existing ProseMirror selection is exactly where the old
   * textarea's `selectionStart` would have pointed). A no-op on an empty
   * string (ProseMirror text nodes must be non-empty).
   */
  insertAtCursor(text: string): void;
  clear(): void;
  focus(): void;
  isEmpty(): boolean;
  /**
   * The contenteditable DOM node (`editor.view.dom`). `useComposerFocus`
   * (`hooks/use-composer-focus.ts`) needs a `RefObject<HTMLElement>` aimed
   * at this exact element — it calls `.focus()` and
   * `.contains(document.activeElement)` on it directly — and `ComposerEditor`
   * otherwise exposes no element, no `editor`, and `EditorContent` itself
   * takes no ref. `autoFocus` only covers TipTap's own mount-time
   * `autofocus`; it does not cover re-focus-when-revealed, the
   * `focus-session-textarea` event, or the type-ahead redirect, all of which
   * live in `useComposerFocus`. Wiring the hook to this element is Task 12's
   * job, not this one's — this only exposes the element.
   */
  getElement(): HTMLElement | null;
}

export interface ComposerEditorProps {
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onSubmit: () => void;
  /**
   * Fires ONLY on the empty↔non-empty boundary — once when the first character
   * is typed, once when the last is deleted, never in between. This is the
   * whole reason the toolbar stops re-rendering per keystroke.
   */
  onEmptyChange: (isEmpty: boolean) => void;

  /** `@` mention menu data sources — see `menus/mention-controller.ts`. */
  agents?: Agent[];
  sessions?: Session[];
  /** Excluded from the `@` session list — you can't mention the session you're in. */
  currentSessionId?: string;

  /** `/` menu data + the two things a row selection can produce — see `menus/slash-controller.ts`. */
  commands?: Command[];
  /**
   * A real OpenCode command was picked from the `/` menu. Notification only:
   * the command has already been inserted into the document as an inline chip
   * (`menus/slash-controller.ts`'s `command()`), and it needs nothing from the
   * host to survive. `ComposerEditor` never executes a command itself — the
   * host reads `getContent().commandName` at submit time.
   */
  onSelectCommand?: (command: Command) => void;
  /**
   * CSS selector for an element the `/` menu should render INTO, in normal
   * flow, instead of floating at the caret. `composer.tsx` points this at a
   * dock it renders directly above the composer card. Omitted → the `/` menu
   * floats like `@` does. See `menus/mount.ts`'s `mountDockedMenu`.
   */
  slashDockSelector?: string;
  /**
   * A composer action was picked from the `/` menu (switch-model, set-scope,
   * ...). The host owns what each action id opens or does — see
   * `menus/slash-actions.ts` for the full list.
   */
  onSelectAction?: (action: SlashAction) => void;
  /**
   * Overrides the `/` menu's Actions section — Task 13. Defaults to
   * `SLASH_ACTIONS` (`menus/slash-actions.ts`), same as before this prop
   * existed. `slash-controller.ts`'s `buildSlashSections` already took an
   * `actions` override (`slash-items.ts`, "overridable for tests"), but
   * nothing threaded it through from a host until now — passing `commands={
   * []}` while a command is staged emptied the Commands/Skills/MCP sections
   * but left Actions (switch-model, switch-agent, ...) fully populated, so
   * the `/` palette still opened over a staged command's argument field.
   * Pass `[]` to suppress the menu completely in that state.
   */
  actions?: SlashAction[];

  /**
   * Fires on the false<->true boundary of "is EITHER the `@` or the `/`
   * menu open right now" — the OR of `mention-controller.ts`'s and
   * `slash-controller.ts`'s own `onOpenChange` (each already fires on its
   * own open<->close boundary; this combines the two into the single signal
   * a host needs). Task 9's seam for `useMenuRevalidation`
   * (`../hooks/use-file-search.ts`) — see `composer.tsx`'s call site.
   */
  onMenuOpenChange?: (isOpen: boolean) => void;
}

/**
 * Wraps `onEmptyChange` so it fires ONLY on the empty<->non-empty boundary.
 * Exported (rather than kept as an inline `useEditor({ onUpdate })` closure)
 * so this exact production logic can be driven against a real, headless
 * `@tiptap/core` Editor in composer-editor.test.ts — TipTap's `Editor` class
 * runs fully without a DOM when constructed without an `element` option (its
 * `view` getter falls back to a stub that still dispatches transactions and
 * emits `update`), so the boundary behaviour is provable without a browser.
 */
export function trackEmptyBoundary(onEmptyChange: (isEmpty: boolean) => void) {
  let wasEmpty = true;
  return ({ editor }: { editor: Pick<Editor, 'isEmpty'> }) => {
    const isEmptyNow = editor.isEmpty;
    if (isEmptyNow !== wasEmpty) {
      wasEmpty = isEmptyNow;
      onEmptyChange(isEmptyNow);
    }
  };
}

/**
 * Enter submits, Shift+Enter inserts a newline — the composer's only custom
 * keymap behaviour. Exported (same reasoning as `trackEmptyBoundary`) so
 * it's directly testable without a DOM: it never touches `view`, only the
 * event and the two live callbacks it's given.
 *
 * `isDisabled()` is a getter, not a boolean, because `editable={false}`
 * alone does NOT stop this from firing (fix round 1, Important 1):
 * `editable` only blocks ProseMirror from applying document-changing
 * transactions, it does not stop `handleKeyDown` from being invoked at all,
 * and `onSubmit()` is an imperative side effect this handler calls directly
 * — nothing about a disabled editor would otherwise stop a stray Enter from
 * submitting.
 */
export function createSubmitOnEnterHandler(
  onSubmit: () => void,
  isDisabled: () => boolean,
): (view: EditorView, event: KeyboardEvent) => boolean {
  return (_view, event) => {
    if (isDisabled()) return false;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
      return true;
    }
    return false;
  };
}

/**
 * The DOM-free equivalent of an empty document. `editor.commands.clearContent()`
 * (fix round 1, Decision 3) calls `setContent('')` internally — a bare
 * string, always HTML-parsed, same as above. `clear()` uses this instead.
 */
const EMPTY_DOC: JSONContent = { type: 'doc', content: textToParagraphs('') };

/**
 * `getDocument`/`setDocument`/`insertAtCursor`'s actual implementations —
 * Task 13, fix round 1, Important 2. Pulled out of `useImperativeHandle`'s
 * factory into standalone functions parameterized by `editor: Editor | null`
 * for the same reason `trackEmptyBoundary`/`createSubmitOnEnterHandler`
 * above are: this repo's `bun test` has no DOM, so anything living only
 * inside the React ref-forwarding closure is unreachable from a test. These
 * three, called against a headless `@tiptap/core` `Editor` (same
 * `createHeadlessEditor` pattern the rest of this file's tests already use),
 * are exercised directly in `composer-editor.test.ts`.
 */
export function getEditorDocument(editor: Editor | null): JSONContent {
  return editor ? (editor.getJSON() as JSONContent) : EMPTY_DOC;
}

export function setEditorDocument(editor: Editor | null, doc: JSONContent): void {
  if (!editor) return;
  const content = doc.content ?? [];
  editor.commands.setContent({ type: 'doc', content });
  editor.commands.focus('end');
}

/**
 * Task 13, fix round 1, Important 2's specific regression guard: this must
 * insert INLINE at the current selection (`editor.commands.insertContent`
 * with no leading `{ type: 'paragraph' }`), never split the document into a
 * new paragraph. `composer-editor.test.ts` asserts `childCount === 1` after
 * inserting mid-word specifically to pin this down — the bug this primitive
 * exists to fix (round 1's `insertContent([{type:'paragraph'}, ...])`-based
 * `onTypeAhead` corrupting a non-empty document) produces `childCount > 1`
 * at the same position.
 */
export function insertTextAtCursor(editor: Editor | null, text: string): void {
  if (!editor || !text) return;
  const segments = text.split('\n');
  const content: JSONContent[] = [];
  segments.forEach((segment, i) => {
    if (segment) content.push({ type: 'text', text: segment });
    if (i < segments.length - 1) content.push({ type: 'hardBreak' });
  });
  if (content.length === 0) return;
  editor.commands.insertContent(content);
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(
  function ComposerEditor(
    {
      placeholder,
      disabled,
      autoFocus,
      onSubmit,
      onEmptyChange,
      agents,
      sessions,
      currentSessionId,
      commands,
      onSelectCommand,
      onSelectAction,
      actions,
      slashDockSelector,
      onMenuOpenChange,
    },
    ref,
  ) {
    // Mirrors use-composer-focus.ts's onTypeAheadRef: @tiptap/react only
    // resyncs `onUpdate`/other callback options when some OTHER option also
    // changed (it explicitly ignores their identity in its own option
    // comparison), so a fresh inline callback each render would otherwise go
    // stale. Applied to every value a stable, memoized-once closure below
    // needs to read fresh: onEmptyChange, onSubmit, disabled, placeholder.
    const onEmptyChangeRef = useRef(onEmptyChange);
    useEffect(() => {
      onEmptyChangeRef.current = onEmptyChange;
    }, [onEmptyChange]);

    const onSubmitRef = useRef(onSubmit);
    useEffect(() => {
      onSubmitRef.current = onSubmit;
    }, [onSubmit]);

    const disabledRef = useRef(disabled ?? false);
    useEffect(() => {
      disabledRef.current = disabled ?? false;
    }, [disabled]);

    const placeholderRef = useRef(placeholder);
    useEffect(() => {
      placeholderRef.current = placeholder;
    }, [placeholder]);

    // Same "extensions are frozen at construction" reasoning as
    // `placeholderRef` above (see extensions.ts) — the mention/slash
    // suggestion extensions built below only run their `getX()` getters at
    // the moment a menu opens or updates, never at construction, so these
    // refs are what keeps the `@`/`/` menus reading LIVE data instead of
    // whatever was current the moment the editor first mounted.
    const agentsRef = useRef(agents ?? []);
    useEffect(() => {
      agentsRef.current = agents ?? [];
    }, [agents]);

    const sessionsRef = useRef(sessions ?? []);
    useEffect(() => {
      sessionsRef.current = sessions ?? [];
    }, [sessions]);

    const currentSessionIdRef = useRef(currentSessionId);
    useEffect(() => {
      currentSessionIdRef.current = currentSessionId;
    }, [currentSessionId]);

    const commandsRef = useRef(commands ?? []);
    useEffect(() => {
      commandsRef.current = commands ?? [];
    }, [commands]);

    // Same live-getter reasoning as commandsRef — defaults to SLASH_ACTIONS
    // (buildSlashSections' own default, made explicit here rather than left
    // implicit) so an unset `actions` prop is byte-identical to before this
    // prop existed.
    const actionsRef = useRef(actions ?? SLASH_ACTIONS);
    useEffect(() => {
      actionsRef.current = actions ?? SLASH_ACTIONS;
    }, [actions]);

    const onSelectCommandRef = useRef(onSelectCommand);
    useEffect(() => {
      onSelectCommandRef.current = onSelectCommand;
    }, [onSelectCommand]);

    const onSelectActionRef = useRef(onSelectAction);
    useEffect(() => {
      onSelectActionRef.current = onSelectAction;
    }, [onSelectAction]);

    const onMenuOpenChangeRef = useRef(onMenuOpenChange);
    useEffect(() => {
      onMenuOpenChangeRef.current = onMenuOpenChange;
    }, [onMenuOpenChange]);

    /**
     * Guards `createSubmitOnEnterHandler` (below) against submitting the
     * whole message when Enter is actually meant to accept a highlighted
     * `@`/`/` row. ProseMirror's `EditorView.someProp` checks the view's OWN
     * direct props (what `editorProps.handleKeyDown` below becomes) BEFORE
     * any plugin's `props.handleKeyDown` — including the Suggestion plugins'
     * (verified against the installed `prosemirror-view`'s `someProp`:
     * `this._props` first, then `directPlugins`, then `state.plugins`) — so
     * without this the submit handler would always win the race and a
     * `@`/`/` menu would never get a chance to consume Enter.
     *
     * Each controller writes ONLY its own flag — fix round 1, Critical:
     * TipTap reverses the extension list when building ProseMirror plugins
     * (`@tiptap/core`'s `resolveExtensions`), so `slashSuggestion`'s plugin
     * view actually updates BEFORE `mentionSuggestion`'s inside a single
     * transaction. A caret move from inside `@foo` straight into `/bar`
     * therefore fires `slash.onStart` (rows found → flag on) followed by
     * `mention.onExit` (→ flag off) in the SAME transaction. A single shared
     * ref would have the mention controller's "off" clobber the slash
     * controller's "on" a moment earlier, leaving the guard off while the
     * slash menu is still open. Two independent flags, OR'd together below,
     * make that ordering irrelevant — each controller can only ever turn its
     * own flag on or off.
     *
     * Each flag tracks "does at least one row currently exist", NOT "is a
     * trigger match active" — see `MenuNavState`'s doc comment
     * (`menus/menu-nav-state.ts`). A match with zero rows (`@nonexistentfile`,
     * `/xyzzy`) must leave its flag `false` for its entire lifetime, so Enter
     * falls through to submit exactly like the live
     * `mentionItems.length > 0` / `filteredCommands.length > 0` guards at
     * `session-chat-input.tsx:932`/`:958`/`:990` — not stay `true` from open
     * to close and swallow Enter into a no-op paragraph split.
     */
    const mentionHasRowsRef = useRef(false);
    const slashHasRowsRef = useRef(false);

    /**
     * Task 9's `onMenuOpenChange` — the OR of the two controllers' own
     * `onOpenChange`, same two-independent-flags-OR'd-together shape as
     * `mentionHasRowsRef`/`slashHasRowsRef` above and for the identical
     * reason (TipTap's reversed extension order can fire one controller's
     * `onExit` and the other's `onStart` inside a single transaction).
     * `reportedMenuOpenRef` is the boundary guard: without it, a caret move
     * from inside `@foo` straight into `/bar` would report `true` (mention
     * opens) then immediately `false` then `true` again in one transaction
     * instead of staying `true` throughout — which would fire
     * `useMenuRevalidation`'s effect on every such move instead of only on
     * a genuine closed->open transition.
     */
    const mentionMenuOpenRef = useRef(false);
    const slashMenuOpenRef = useRef(false);
    const reportedMenuOpenRef = useRef(false);
    const reportMenuOpenChange = useMemo(
      () => () => {
        const next = mentionMenuOpenRef.current || slashMenuOpenRef.current;
        if (next === reportedMenuOpenRef.current) return;
        reportedMenuOpenRef.current = next;
        onMenuOpenChangeRef.current?.(next);
      },
      [],
    );

    const handleUpdate = useMemo(
      () => trackEmptyBoundary((isEmpty) => onEmptyChangeRef.current(isEmpty)),
      [],
    );

    const handleKeyDown = useMemo(
      () =>
        createSubmitOnEnterHandler(
          () => onSubmitRef.current(),
          () => disabledRef.current || mentionHasRowsRef.current || slashHasRowsRef.current,
        ),
      [],
    );

    const editor = useEditor({
      immediatelyRender: false, // required: Next SSR
      autofocus: autoFocus,
      editable: !disabled,
      extensions: [
        ...baseExtensions(() => placeholderRef.current),
        MentionNode,
        // The one `@tiptap/suggestion` code path both `@` and `/` register
        // through (editor/suggestion.ts's `createSuggestionExtension`).
        // Built fresh every render like every extension above, but only the
        // FIRST evaluation is ever used — `Editor.setOptions()` never
        // rebuilds the extension manager (see extensions.ts) — which is
        // exactly why every value each factory needs is read through a ref
        // getter (`agentsRef.current`, ...) instead of closed over directly.
        createSuggestionExtension(
          'mentionSuggestion',
          createMentionSuggestion({
            getAgents: () => agentsRef.current,
            getSessions: () => sessionsRef.current,
            getCurrentSessionId: () => currentSessionIdRef.current,
            onHasRowsChange: (hasRows) => {
              mentionHasRowsRef.current = hasRows;
            },
            onOpenChange: (isOpen) => {
              mentionMenuOpenRef.current = isOpen;
              reportMenuOpenChange();
            },
          }),
        ),
        createSuggestionExtension(
          'slashSuggestion',
          createSlashSuggestion({
            getCommands: () => commandsRef.current,
            getActions: () => actionsRef.current,
            // NOT read through a ref, unlike every getter around it. This is
            // frozen at construction on purpose: it is a per-instance
            // selector string that identifies this composer's dock element
            // and never changes for the component's lifetime. The plugin
            // resolves it with `document.querySelector` at MOUNT time, so the
            // dock is free to render after the editor does — which it does.
            dockSelector: slashDockSelector,
            onSelectCommand: (command) => onSelectCommandRef.current?.(command),
            onSelectAction: (action) => onSelectActionRef.current?.(action),
            onHasRowsChange: (hasRows) => {
              slashHasRowsRef.current = hasRows;
            },
            onOpenChange: (isOpen) => {
              slashMenuOpenRef.current = isOpen;
              reportMenuOpenChange();
            },
          }),
        ),
      ],
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Message input',
          /**
           * `min-h-[3.5em]` — taller than one line by design. History: was
           * `1.5em` (exactly one line) on the reasoning that a taller floor
           * made an empty composer look padded beyond its content; bumped to
           * `2.25em` on 2026-08-17 (Jay's call, "just slightly"); bumped
           * again here on 2026-08-18 (explicit follow-up ask — the first
           * bump still read as short) to `3.5em` (~2.3 lines). Still short
           * of the old `3rem` floor this was originally written to avoid in
           * spirit, but the "avoid padding an empty composer" reasoning has
           * now been outweighed twice by "it still looks too short" — if
           * asked again, stop nudging by increments and ask what target
           * looks right instead. It still grows with the text past this
           * floor.
           *
           * The `vh` cap ladder used to be 45vh / **25vh** / 40vh — the middle
           * band, 640–1023px, was the SHORTEST of the three, so a tablet or a
           * narrow desktop window capped the draft at barely a quarter of the
           * viewport while a phone got 45%. That was carried over verbatim from
           * a reference and left in place with a note inviting this change. The
           * curve is now monotonic: 45vh below 640px (a phone keyboard eats the
           * rest of the screen anyway), 40vh above it.
           */
          class: 'outline-none min-h-[1.7em] max-h-[45vh] sm:max-h-[40vh] overflow-y-auto',
        },
        handleKeyDown,
      },
      onUpdate: handleUpdate,
    });

    useEffect(() => {
      editor?.setEditable(!disabled);
    }, [editor, disabled]);

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr);
    }, [editor, placeholder]);

    useImperativeHandle(
      ref,
      (): ComposerEditorHandle => ({
        getContent: () =>
          editor ? serializeDocument(editor.state.doc) : { text: '', mentions: [] },
        setContent: (text) => {
          if (!editor) return;
          const paragraphs = textToParagraphs(text);
          editor.commands.setContent({ type: 'doc', content: paragraphs });
          editor.commands.focus('end');
        },
        getDocument: () => getEditorDocument(editor),
        setDocument: (doc) => setEditorDocument(editor, doc),
        insertAtCursor: (text) => insertTextAtCursor(editor, text),
        clear: () => editor?.commands.setContent(EMPTY_DOC),
        focus: () => editor?.commands.focus('end'),
        isEmpty: () => editor?.isEmpty ?? true,
        getElement: () => (editor && !editor.isDestroyed ? editor.view.dom : null),
      }),
      [editor],
    );

    return (
      <EditorContent
        editor={editor}
        className={cn(
          // `text-base` (16px) on mobile, NOT 15px: iOS Safari force-zooms the
          // page on focus for any input under 16px, and the composer is the one
          // field on the screen. `sm:text-sm` above 640px, which is the size
          // `globals.css`'s slash-trigger rule already documents.
          'kortix-composer-editor w-full text-base sm:text-sm',
          disabled && 'opacity-50',
        )}
      />
    );
  },
);
