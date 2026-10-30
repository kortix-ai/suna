/**
 * The typographic metrics of the composer's first line of text, shared by the
 * TWO elements that can draw a glyph at that exact position:
 *
 *  1. the contenteditable itself — `editor/composer-editor.tsx`'s
 *     `editorProps.attributes.class`, which carries the caret, the typed
 *     text, and TipTap's own `::before` placeholder; and
 *  2. `AnimatedComposerPlaceholder` (`animated-placeholder.tsx`), an
 *     absolutely-positioned overlay that REPLACES that `::before` whenever the
 *     rotating hints are running — which is the normal empty-composer state
 *     (`composer.tsx`: `animatePlaceholder = isEmpty && !editorDisabled &&
 *     !lockForQuestion`, and the editor is handed `''` while it holds).
 *
 * They live in different layout contexts and neither can see the other's box:
 * the overlay is positioned against the WRAPPER's padding box (`inset-x-2`,
 * mirroring that wrapper's `px-2`), while the editor's own padding sits
 * strictly inside it. So horizontal padding added to the contenteditable is
 * invisible to the overlay, and the placeholder silently stops lining up with
 * the caret sitting under it — which is exactly what happened when `px-0.5`
 * was added to the editor alone. The overlay kept drawing at the old x.
 *
 * Anything that changes where or how the first glyph lands — horizontal
 * padding, `tracking-*`, `leading-*` — belongs HERE, not inlined at either
 * site, so the two can never drift again. Font SIZE is deliberately not here:
 * `text-base sm:text-sm` is already duplicated at both sites and is load-
 * bearing on the editor for a separate reason (iOS focus zoom below 16px).
 */
export const COMPOSER_TEXT_METRICS = 'px-0.5';
