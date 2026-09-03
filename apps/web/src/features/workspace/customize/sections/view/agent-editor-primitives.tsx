'use client';

/**
 * Layout primitives for the agent editor. Three shapes and nothing else: a
 * titled section, a row (label left, control right), and a block (label above
 * a full-width control).
 *
 * There is deliberately NO icon slot. Every group used to open with a glyph —
 * a stack, a chip, a gauge, a shield — and not one of them named anything the
 * words beside it did not already say. Type carries the hierarchy: section
 * titles at `text-sm font-medium`, help at `text-xs text-muted-foreground`.
 * Those two sizes are the whole scale; nothing in the editor is smaller.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * How a section draws itself. `flat` is the original: a heading over
 * hairline-divided rows, for a section sitting on a `bg-popover` pane where a
 * second tinted panel would add a border and no contrast. `panel` is the
 * agent page's configuration pane (Marko, 2026-09-03: "visually show the
 * member list separate from Access"): each section is its own
 * `bg-popover rounded-md border` card with a divided header, so two sections
 * on one tab read as two things, not one list with two headings.
 *
 * A context, not a prop, because the sections are composed by a shell that
 * does not own their props — the shell sets the style once for everything
 * under it.
 */
export type EditorSectionStyle = 'flat' | 'panel';
const EditorSectionStyleContext = createContext<EditorSectionStyle>('flat');
export function EditorSectionStyleProvider({
  value,
  children,
}: {
  value: EditorSectionStyle;
  children: ReactNode;
}) {
  return (
    <EditorSectionStyleContext.Provider value={value}>{children}</EditorSectionStyleContext.Provider>
  );
}

/**
 * One titled group of settings. Rows inside are separated by hairlines rather
 * than boxed individually. See `EditorSectionStyle` for the two dialects.
 */
export function EditorSection({
  title,
  description,
  trailing,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** A summary at the header's right edge — a `Badge` saying "All" or
   *  "3 picked" — so a card answers its question before it is opened. */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const style = useContext(EditorSectionStyleContext);
  const heading = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        {description ? (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{description}</p>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
  if (style === 'panel') {
    return (
      <section className="bg-popover rounded-md border">
        <div className="border-border/60 border-b px-4 pt-4 pb-3">{heading}</div>
        <div className={cn('divide-border/60 divide-y px-4')}>{children}</div>
      </section>
    );
  }
  return (
    <section className="space-y-2">
      {heading}
      <div className="divide-border/60 divide-y">{children}</div>
    </section>
  );
}

/**
 * Label and help on the left, control on the right — for anything that fits a
 * switch, a select, a slider, or a short input. Stacks under `sm` so a narrow
 * pane never squeezes the control down to nothing. The control is `w-52`
 * (208px): the row lives in the agent page's 28rem column, and at the old
 * `w-60` the label beside it was 100px wide and wrapped every help line
 * three deep.
 */
export function SettingRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <SettingLabel label={label} help={help} />
      <div className="w-full shrink-0 sm:w-52">{children}</div>
    </div>
  );
}

/**
 * Label and help above a full-width control — for anything a row cannot hold:
 * a textarea, a grant checklist, the permission tree.
 */
export function SettingBlock({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2.5 py-3.5">
      <SettingLabel label={label} help={help} />
      {children}
    </div>
  );
}

/**
 * The label pair. A plain `<span>`, not `<Label>`: none of these controls take
 * an id we could point `htmlFor` at, and a `<label>` that references nothing
 * is a dangling a11y reference plus a cursor that lies. Each control carries
 * its own `aria-label` instead.
 */
function SettingLabel({ label, help }: { label: string; help?: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <span className="text-foreground block text-sm font-medium">{label}</span>
      {help ? (
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{help}</p>
      ) : null}
    </div>
  );
}

/**
 * A text button that lives inside a help line — "Reset", "Clear". Text, not an
 * icon: at this size an icon is a guess, and the word is three characters
 * longer.
 */
export function InlineAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-foreground underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-70"
    >
      {children}
    </button>
  );
}
