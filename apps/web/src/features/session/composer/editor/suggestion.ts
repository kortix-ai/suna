import { Extension } from '@tiptap/core';
import type { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';

/**
 * The render-callback shape both the `@` mention menu and the `/` slash menu
 * implement. This is the one `@tiptap/suggestion` code path both triggers go
 * through — `createMentionSuggestion` (`../menus/mention-menu.tsx`) and
 * `createSlashSuggestion` (`../menus/slash-menu.tsx`) each build a
 * `MenuController` and hand it to `baseSuggestion` below.
 *
 * `onKeyDown` only receives `{view, event, range}` — NOT the full
 * `SuggestionProps` (verified against the installed
 * `@tiptap/suggestion@3.27.1`'s `plugin/props.ts`: the plugin's own
 * `handleKeyDown` calls `renderer.onKeyDown({view, event, range})`, nothing
 * richer). A controller therefore has to remember its own latest
 * `SuggestionProps` (for `.command`, to actually run a selection from the
 * keyboard) and its own latest flat row list (for what Enter/Tab should
 * select, and for how far ↑/↓ may wrap) in plain closure state across calls —
 * this is what keeps the selection index a DERIVED value instead of React
 * state, per Task 6's `moveSelection`/`clampSelection` design: there is no
 * React component above a controller for state to live in until the popup
 * actually mounts, and even then the popup is fed `selectedIndex` as a prop,
 * never owns it.
 *
 * Escape is not handled here on purpose: `@tiptap/suggestion`'s own
 * `handleKeyDown` intercepts `Escape`/`Esc` before calling into a renderer at
 * all, and unconditionally dispatches an exit transaction afterward (see
 * `createSuggestionProps` in the installed package) — every keyboard-driven
 * dismiss already reaches `onExit` without a controller doing anything.
 */
export interface MenuController<TSelected> {
  onStart(props: SuggestionProps<never, TSelected>): void;
  onUpdate(props: SuggestionProps<never, TSelected>): void;
  onKeyDown(props: SuggestionKeyDownProps): boolean;
  onExit(props: SuggestionProps<never, TSelected>): void;
}

/**
 * `allowedPrefixes: [' ', '\n']` reproduces the old rule — a trigger only
 * fires at the start of input or after whitespace, so `user@example.com` is
 * not a mention — without the backwards character walk at
 * session-chat-input.tsx:1011-1032.
 *
 * `startOfLine: false` is the fix for `/` being stuck at position 0. The old
 * regex was `/^\/(\S*)$/`, which made a slash command after a newline
 * impossible.
 */
export function baseSuggestion<TSelected>(
  char: string,
  pluginKey: PluginKey,
  controller: MenuController<TSelected>,
): Omit<SuggestionOptions<never, TSelected>, 'editor'> {
  return {
    char,
    pluginKey,
    startOfLine: false,
    allowedPrefixes: [' ', '\n'],
    items: () => [],
    render: () => ({
      onStart: (props) => controller.onStart(props),
      onUpdate: (props) => controller.onUpdate(props),
      onKeyDown: (props) => controller.onKeyDown(props),
      onExit: (props) => controller.onExit(props),
    }),
  };
}

/**
 * Wraps a fully-built `SuggestionOptions` (minus `editor`, which only exists
 * once the extension is attached) as a standalone TipTap extension.
 * `composer-editor.tsx` registers one of these per trigger char.
 */
export function createSuggestionExtension<TSelected>(
  name: string,
  options: Omit<SuggestionOptions<never, TSelected>, 'editor'>,
) {
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      return [Suggestion<never, TSelected>({ editor: this.editor, ...options })];
    },
  });
}
