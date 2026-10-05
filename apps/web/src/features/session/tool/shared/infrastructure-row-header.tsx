'use client';

import { DiffStat, STATUS_TEXT } from '@/components/ui/status';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { WarningIcon as AlertTriangle } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { useToolOpen } from './infrastructure-contexts';
import { type ToolOutcome } from './tool-outcome';
import { type TriggerTitle } from '@/ui';
import { isTriggerTitle } from './infrastructure-parts';

// Shared class for the compact single-line "row" layout used by every inline mode.
//
// The colour rule skips `[data-tone]` icons. It is a descendant selector on the
// ROW — `(0,2,2)` — so it outranks any `text-*` class the icon carries itself
// `(0,1,0)`, and it silently repainted every toned leading icon. Excluding
// toned icons by attribute keeps the verdict icon's OWN class authoritative
// without an `!important` arms race inside a shared class.
export const TOOL_ROW_CLASS = cn(
  'flex items-center gap-1.5 py-0.5',
  'text-xs text-muted-foreground/70 transition-colors select-none max-w-full group',
  '[&>span:first-child>svg]:size-4 [&>span:first-child>svg:not([data-tone])]:text-muted-foreground',
);

/**
 * The leading icon for a step that failed.
 *
 * It REPLACES the tool's own icon rather than sitting beside it. A globe next
 * to a warning reads as "a web page, and separately, a problem"; the row has
 * one 16px gutter, and the thing the reader needs from it is the verdict — the
 * tool's identity is still spelled out in the title immediately to its right.
 *
 * One glyph, one muted tone: the triangle itself is the verdict, and it stays
 * `neutral` so a failed step reads as information beside the row's title, not
 * as an alarm. Which KIND of failure it was still travels on `data-tone` and
 * the aria-label. Same triangle `ScrapeResultItem` already puts on a dead URL
 * inside the card, so the summary row and the row it summarises say the same
 * thing with the same mark.
 */
/**
 * The verdict mark on a tool row.
 *
 * It carries an accessible name because for some rows it is the ONLY failure
 * signal: a call that returned its error settles as `completed`, so the title
 * still reads "Ran command" and the tint is all that says otherwise. Every other
 * failure glyph in the turn is labelled (`activity-burst.tsx`,
 * `activity-file-chips.tsx`); this one was the exception.
 */
export function ToolOutcomeIcon({ outcome }: { outcome: Exclude<ToolOutcome, 'ok'> }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <AlertTriangle
      weight="fill"
      data-tone={outcome}
      aria-label={
        outcome === 'failed'
          ? tI18nComplete.raw('textf0103f528539')
          : tI18nComplete.raw('text2c9f21686e34')
      }
      className={cn('size-4 shrink-0', STATUS_TEXT.neutral)}
    />
  );
}

// Title + subtitle + args, rendered for the compact inline row layout.
function InlineTriggerTitle({
  trigger,
  running,
  onSubtitleClick,
}: {
  trigger: TriggerTitle;
  running: boolean;
  onSubtitleClick?: () => void;
}) {
  const args = trigger.args ?? [];
  // Read HERE rather than in the tool: this component renders inside
  // `BasicTool`'s `ToolOpenContext` provider, and the tool's own body does not.
  // See `TriggerTitle.hideSubtitleWhenOpen` for when a caller sets the flag.
  const open = useToolOpen();
  const subtitle = open && trigger.hideSubtitleWhenOpen ? undefined : trigger.subtitle;

  return (
    <>
      <span className="text-foreground shrink-0 text-sm whitespace-nowrap">{trigger.title}</span>
      {(subtitle || args.length > 0 || trigger.stat) && (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {subtitle &&
            (running ? (
              <TextShimmer className="min-w-0 truncate text-sm">{subtitle}</TextShimmer>
            ) : (
              // Painted as a link, so it must behave like one for the keyboard
              // too. Kept as a <span role="button"> rather than a real <button>
              // because this content is cloned into the disclosure's own trigger
              // button — nesting one button in another is invalid HTML.
              <span
                className={cn(
                  'text-muted-foreground min-w-0 truncate text-sm',
                  onSubtitleClick &&
                    'hover:text-foreground cursor-pointer underline-offset-2 hover:underline',
                )}
                role={onSubtitleClick ? 'button' : undefined}
                tabIndex={onSubtitleClick ? 0 : undefined}
                // Last, so the rendered markup keeps `title="…">…</span>` — the
                // shape the memory-tool trigger tests pin.
                title={subtitle}
                onKeyDown={
                  onSubtitleClick
                    ? (e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        e.stopPropagation();
                        onSubtitleClick();
                      }
                    : undefined
                }
                onClick={
                  onSubtitleClick
                    ? (e) => {
                        e.stopPropagation();
                        onSubtitleClick();
                      }
                    : undefined
                }
              >
                {subtitle}
              </span>
            ))}
          {/* `shrink-0`: the count is the row's verdict-sized fact, so a long
              filename truncates before the stat gives up a digit. DiffStat
              nulls itself when both counts are zero. */}
          {trigger.stat && (
            <DiffStat
              additions={trigger.stat.additions}
              deletions={trigger.stat.deletions}
              className="shrink-0 text-xs"
            />
          )}
          {args.length > 0 && (
            <>
              {subtitle && <span className="text-muted-foreground/40 shrink-0">·</span>}
              <span
                className="text-muted-foreground/40 min-w-0 truncate text-sm"
                title={args.join(' · ')}
              >
                {args.join(' · ')}
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}

// The full inline header line: icon, trigger content (or streaming skeleton), right cluster.
export function ToolHeaderRow({
  icon,
  trigger,
  running,
  onSubtitleClick,
  outcome = 'ok',
  action,
}: {
  icon?: React.ReactNode;
  trigger: TriggerTitle | React.ReactNode;
  running: boolean;
  onSubtitleClick?: () => void;
  outcome?: ToolOutcome;
  action?: React.ReactNode;
}) {
  const triggerIsEmpty = isTriggerTitle(trigger) ? !trigger.title && !trigger.subtitle : false;

  // A failed step leads with the verdict, not with the tool. Placed here rather
  // than in each renderer because every one of them hardcodes its own icon and
  // none of them look at the output.
  const leading = outcome === 'ok' ? icon : <ToolOutcomeIcon outcome={outcome} />;

  return (
    <>
      {leading && <span className="text-muted-foreground size-4 shrink-0">{leading}</span>}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {isTriggerTitle(trigger) ? (
          <InlineTriggerTitle
            trigger={trigger}
            running={running}
            onSubtitleClick={onSubtitleClick}
          />
        ) : (
          trigger
        )}
      </div>
      {/* Outside the `flex-1` wrapper, so it is the row's far right edge and
          the title/subtitle inside that wrapper take the truncation. `ml-auto`
          is the belt to the flex-1 braces: a trigger with no subtitle and no
          args renders a title that does not fill the wrapper. */}
      {action && <span className="ml-auto flex shrink-0 items-center">{action}</span>}
    </>
  );
}

/**
 * The row title's shrink priority: it yields LAST, and only to a cap.
 *
 * Title and subtitle are flex siblings, and both used to be plain `min-w-0
 * truncate` — no shrink priority at all, so flexbox took the overflow out of
 * both in proportion to their content. A long subtitle therefore ate the
 * title: the `testing` skill's row rendered as `t…` beside 28 characters of
 * description, and `mcp__linear__create_issue` rendered as `C..`. The name is
 * the one thing a closed row exists to say, so it cannot be the part that
 * loses.
 *
 * `shrink-0` alone would let a sentence-length title push the subtitle off the
 * card entirely, which is the same failure mirrored. The `max-w-[60%]` cap is
 * the second half: a short title always renders whole, a long one truncates at
 * 60% of the trigger and leaves the rest to the subtitle.
 */
const PANEL_TITLE_CLASS = 'min-w-0 max-w-[60%] shrink-0 truncate';

/**
 * Title + subtitle + args on ONE line, for the panel's disclosure row.
 *
 * The panel used to stack these — an `h3` with a second mono line under it —
 * which is a page header, and a page header only works when there is one call
 * on the page. A detail routinely holds several, so the unit here is a row: one
 * line, closed, that says which call this is and nothing more. Everything the
 * old header showed still shows, it just reads left-to-right instead of
 * top-to-bottom.
 */
export function PanelRowTitle({
  trigger,
  running,
  onSubtitleClick,
}: {
  trigger: TriggerTitle;
  running: boolean;
  onSubtitleClick?: () => void;
}) {
  const args = trigger.args ?? [];
  // Same read, same reason as the inline row — one behaviour, two surfaces.
  const open = useToolOpen();
  const subtitle = open && trigger.hideSubtitleWhenOpen ? undefined : trigger.subtitle;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
      {running ? (
        <TextShimmer className={cn(PANEL_TITLE_CLASS, 'text-sm font-medium')}>
          {trigger.title || 'Working'}
        </TextShimmer>
      ) : (
        <span className={cn('text-foreground text-sm font-medium', PANEL_TITLE_CLASS)}>
          {trigger.title}
        </span>
      )}
      {subtitle && (
        <span
          className={cn(
            'text-muted-foreground min-w-0 truncate font-mono text-xs',
            onSubtitleClick &&
              'hover:text-foreground cursor-pointer underline-offset-2 hover:underline',
          )}
          title={subtitle}
          // `stopPropagation` is load-bearing now and was not before: the
          // subtitle sits INSIDE the disclosure trigger, so without it every
          // "open this file" click would also toggle the row it lives on.
          onClick={
            onSubtitleClick
              ? (e) => {
                  e.stopPropagation();
                  onSubtitleClick();
                }
              : undefined
          }
        >
          {subtitle}
        </span>
      )}
      {/* Same slot as the inline row's: after the name, never truncated. */}
      {trigger.stat && (
        <DiffStat
          additions={trigger.stat.additions}
          deletions={trigger.stat.deletions}
          className="shrink-0 text-xs"
        />
      )}
      {args.length > 0 && (
        <span
          className="text-muted-foreground/60 min-w-0 truncate font-mono text-xs"
          title={args.join(' · ')}
        >
          {args.join(' · ')}
        </span>
      )}
    </div>
  );
}
