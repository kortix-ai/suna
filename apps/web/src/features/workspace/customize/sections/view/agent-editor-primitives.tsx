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

import type { ReactNode } from 'react';

/**
 * One titled group of settings. Rows inside are separated by hairlines rather
 * than boxed individually — the editor sits on `bg-popover` already, so a
 * second popover-tinted panel on top of it would draw a border and no contrast.
 */
export function EditorSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="space-y-1">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        {description ? (
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{description}</p>
        ) : null}
      </div>
      <div className="divide-border/60 divide-y">{children}</div>
    </section>
  );
}

/**
 * Label and help on the left, control on the right — for anything that fits a
 * switch, a select, a slider, or a short input. Stacks under `sm` so a narrow
 * pane never squeezes the control down to nothing.
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
      <div className="w-full shrink-0 sm:w-60">{children}</div>
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
