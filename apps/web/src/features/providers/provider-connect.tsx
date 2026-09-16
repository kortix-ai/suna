'use client';

import { useTranslations } from '@/i18n/use-translations';
/** Shared provider list for Models, Secrets, and the model selector.
 * Rows keep catalog order. Connect and Manage open the same ownership dialog.
 * The prop-only view and credential fields also support isolated render tests.
 */

import { type ReactNode, useMemo, useState } from 'react';
import { ProjectProviderConnection } from './project-provider-connection';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_NOTES, ProviderLogo } from '@/features/providers/provider-branding';
import { ProviderAccessMenu } from '@/features/workspace/customize/sections/llm-provider/provider-access-menu';
import { useConnectedProviders } from '@/features/workspace/customize/sections/llm-provider/use-connected-providers';
import {
  useLiveLlmProviderCatalog,
  useLlmProviderCatalogRevision,
} from '@/features/workspace/customize/sections/llm-provider/use-live-catalog';
import {
  envVarPlaceholder,
  orderProviderRows,
  prettyFieldLabel,
} from '@/features/workspace/customize/sections/llm-provider/utils';
import { LLM_PROVIDERS, type LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { useModelAccess, useProjectModelPickerCatalog } from '@kortix/sdk/react';
import {
  CheckCircleIcon as Check,
  ArrowSquareOutIcon as ExternalLink,
  EyeIcon as Eye,
  EyeSlashIcon as EyeSlash,
  XIcon as Remove,
  MagnifyingGlassIcon as Search,
  WarningCircleIcon as Warning,
} from '@phosphor-icons/react';

/**
 * The three providers JAY-510 makes first-class: "Anthropic (Claude), OpenAI
 * (ChatGPT), Google Gemini". They are the top THREE ROWS, not the only rows —
 * every other provider follows them in catalog order. Deliberately NOT
 * `POPULAR_PROVIDER_IDS` (`provider-branding.tsx:10-17`), which is a
 * different, six-member list that also carries `github-copilot`, `openrouter`
 * and `vercel`; those three sit in the tail, in catalog order.
 */
export const FIRST_CLASS_PROVIDER_IDS = ['anthropic', 'openai', 'google'] as const;

/**
 * Stable label target for a credential input.
 */
export function providerKeyFieldId(providerId: string, envVar: string): string {
  return `provider-connect-${providerId}-${envVar}`;
}

/** Everything one provider row needs. Plain data — the view holds no hooks. */
export interface ProviderConnectRow {
  id: string;
  label: string;
  /**
   * The row subtitle. `PROVIDER_NOTES[id]` verbatim where that 7-key map has an
   * entry; otherwise the catalog's own derived `hint`. Without the fallback
   * every long-tail provider (groq, xai, deepseek, mistral, bedrock, …) would
   * render with no subtitle at all — a content regression against
   * `catalog-tab.tsx`, which showed `{provider.hint}` on every row.
   */
  note?: string;
  /** Credential fields the row collects. One for all three first-class ids. */
  envVars: string[];
  helpUrl: string | null;
  connected: boolean;
  modelCount: number;
  /** Per-env-var input placeholder from `envVarPlaceholder`. Falls back to the
   *  env var name itself so the pure view never needs the catalog entry. */
  placeholders?: Record<string, string>;
}

export interface ProviderConnectViewProps {
  /**
   * THE list. One flat, ordered array — there is no second list and no
   * section.
   *
   * It was `firstClass` + `more`, plus a `connectedSlot` above both, which is
   * how a screen with three providers on it grew three headings, a disclosure
   * with a count, and a row that teleported into a different section the
   * moment you finished typing in it. See `ProviderConnectView`.
   */
  rows: ProviderConnectRow[];
  /** How many providers exist in total. This is the CATALOGUE's size — never
   *  `rows.length` — because it is what the search placeholder counts, and
   *  search always covers the catalogue whatever the list is showing. */
  totalCount: number;
  /**
   * Matching providers this list is NOT rendering, because the reader has not
   * asked for them yet. `0` while searching: a query is a request for its
   * matches, all of them, so `Load more` never stands between a search and its
   * result. See `PROVIDER_PAGE_SIZE`.
   */
  hiddenCount?: number;
  /** Reveal the next page. Omitted (with `hiddenCount` 0) when there is none. */
  onLoadMore?: () => void;
  /** Keyed `${providerId}:${envVar}`. */
  values: Record<string, string>;
  onValueChange: (providerId: string, envVar: string, value: string) => void;
  /**
   * "Focus left this provider's row." NOT "save this" — the host decides
   * whether anything actually changed and whether every field the provider
   * needs is filled. A row fires this on every exit, including the ones where
   * the user typed nothing.
   */
  onCommit: (providerId: string) => void;
  /** Per-provider save state. Absent id → `idle`. */
  statuses?: Record<string, ProviderKeyStatus>;
  /** Per-provider failure text, shown only while that provider is in `error`. */
  errors?: Record<string, string>;
  /** Keyed `${providerId}:${envVar}` — which fields are showing plaintext. */
  revealedFields?: Record<string, boolean>;
  onToggleReveal: (providerId: string, envVar: string) => void;
  /**
   * Read-only members see every row but no credential field and no Connect
   * button — those POST secrets and would 403. Same gate the deleted
   * `CatalogTab` used (`catalog-tab.tsx:68-71`), applied by hiding the write
   * controls instead of folding a subview back to a list.
   */
  canWrite: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  /** Remove a stored key. The host confirms first — this only asks. */
  onRemoveKey?: (providerId: string) => void;
  /** Per-provider extra auth affordance. Only `openai` has one today. */
  subscriptionSlots?: Record<string, ReactNode>;
  accessSlots?: Record<string, ReactNode>;
  wrapCredentials?: (row: ProviderConnectRow, fields: ReactNode) => ReactNode;
  instruction?: ReactNode;
  /** Open the Models tab with this provider's models visible. */
  onOpenModels?: (providerId: string) => void;
  className?: string;
}

/**
 * What a row's credential is doing right now.
 *
 * `error` is the only one that persists on its own: `saving` ends when the
 * provider list refreshes, `saved` when the row leaves the grid for the
 * Connected block, and an error stays until the user types again (see
 * `handleValueChange`) because nothing else would ever clear it.
 */
export type ProviderKeyStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * One credential field, borderless by design.
 *
 * The border is drawn by whatever WRAPS this — a single `InputGroup` for a
 * one-key provider, or one shared box around the stack for a provider that
 * needs three (Bedrock's id/secret/region, Vertex's JSON/project/location).
 * Three separately-bordered boxes for one credential reads as three unrelated
 * settings; one box with seams reads as the one thing it is.
 */
function CredentialField({
  row,
  envVar,
  value,
  revealed,
  onReveal,
  onValueChange,
  trailing,
}: {
  row: ProviderConnectRow;
  envVar: string;
  value: string;
  revealed: boolean;
  onReveal: () => void;
  onValueChange: ProviderConnectViewProps['onValueChange'];
  trailing?: ReactNode;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const id = providerKeyFieldId(row.id, envVar);
  /**
   * A connected provider's field is EMPTY, because the stored key can never be
   * read back — it is write-only by design. The placeholder is therefore the
   * whole state report, and it has to say both halves: that a key is already
   * there, and that typing replaces it.
   *
   * This is what replaced the second list. A saved provider used to vanish
   * from here and reappear in a "Connected" block above with its own
   * "Replace key" button — so finishing a field made the row jump somewhere
   * else, and the same provider was on screen twice.
   *
   * **A multi-field provider keeps each field's own name in that report.** The
   * saved sentence used to replace the placeholder outright, so Bedrock's two
   * fields — "Bearer token bedrock" and "Region" — both collapsed to the same
   * "Saved — paste a new key to replace it" the moment they were stored, and
   * the only thing distinguishing one row from the other went with it. The
   * field name is the ONLY visible identity these rows have (the `<label>`
   * below is `sr-only`), so it leads and the saved state follows it.
   */
  const fieldName = row.placeholders?.[envVar] ?? prettyFieldLabel(envVar);
  const placeholder =
    row.connected && !value
      ? row.envVars.length > 1
        ? `${fieldName} — saved, paste a new one to replace it`
        : 'Saved — paste a new key to replace it'
      : (row.placeholders?.[envVar] ?? envVar);
  return (
    <Field className="min-w-0">
      {/* The label is the ONLY accessible name — an `aria-label` on the input
          would override it and leave this element inert. */}
      <FieldLabel htmlFor={id} className="sr-only">
        {row.label} {prettyFieldLabel(envVar)}
      </FieldLabel>
      <InputGroup className={cn(row.envVars.length > 1 && 'rounded-none border-0')}>
        <InputGroupInput
          id={id}
          // `password` so the browser and any screen-recording tool mask it by
          // default; the reveal button flips it to `text`. It was `text`, which
          // left a pasted key legible to anyone behind you and to every
          // screenshot.
          type={revealed ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          // A `type="password"` field makes 1Password / LastPass / Dashlane
          // inject their own button into the input's trailing edge — directly
          // on top of the reveal button, and followed by an offer to save a
          // provider API key as a website login. These three opt-outs are the
          // vendors' documented ones; nothing here is a credential for THIS
          // site, so none of them has anything to offer.
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange(row.id, envVar, event.target.value)}
          // Enter commits by BLURRING rather than by calling the save directly:
          // the row's own `onBlur` is the one save path, so keyboard and mouse
          // cannot take two different routes to the same mutation.
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <InputGroupAddon align="inline-end" className="gap-1">
          {trailing}
          {/* No reveal button on an empty field — there is nothing to reveal,
              and an eye beside "Saved — paste a new key" promises it can show
              you the stored key, which it cannot.

              `title`, not `Hint`: `Hint` is a Radix tooltip and throws without
              a `TooltipProvider`, and this component's contract is that it
              renders under `renderToStaticMarkup` with no provider tree (see
              this file's header). `aria-label` carries the accessible name. */}
          {value && (
            <InputGroupButton
              size="icon-xs"
              onClick={onReveal}
              title={revealed ? 'Hide' : 'Show'}
              aria-label={
                revealed
                  ? tI18nComplete('text1efc71237433', { value0: row.label })
                  : tI18nComplete('text2c6e8e7b3b77', { value0: row.label })
              }
              aria-pressed={revealed}
              className="text-muted-foreground/60 hover:text-foreground"
            >
              {revealed ? <EyeSlash className="size-3.5" /> : <Eye className="size-3.5" />}
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}

export interface ProviderKeyFieldsProps {
  row: ProviderConnectRow;
  values: Record<string, string>;
  onValueChange: ProviderConnectViewProps['onValueChange'];
  onCommit: ProviderConnectViewProps['onCommit'];
  status: ProviderKeyStatus;
  errorMessage?: string;
  revealedFields: Record<string, boolean>;
  onToggleReveal: ProviderConnectViewProps['onToggleReveal'];
  onRemoveKey?: ProviderConnectViewProps['onRemoveKey'];
  children?: ReactNode;
  className?: string;
}

/**
 * Every credential field a provider needs, plus the one save that covers them.
 *
 * Extracted from `ProviderRow` because two surfaces need the identical thing:
 * the "Add a key" grid, and the Replace control on an already-connected row.
 * A second hand-rolled copy of the commit rule is exactly how one of them ends
 * up saving on a different trigger than the other.
 */
function ProviderKeyFields({
  row,
  values,
  onValueChange,
  onCommit,
  status,
  errorMessage,
  revealedFields,
  onToggleReveal,
  onRemoveKey,
  children,
  className,
}: ProviderKeyFieldsProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const untouched = row.envVars.every((envVar) => !values[`${row.id}:${envVar}`]);
  /**
   * Stored, and not being edited right now. Provider-wide: the credential is
   * one thing however many fields carry it, and it is saved and removed as one.
   */
  const savedAndIdle = row.connected && untouched && status === 'idle';
  const fields = row.envVars.map((envVar, index) => (
    <CredentialField
      key={envVar}
      row={row}
      envVar={envVar}
      value={values[`${row.id}:${envVar}`] ?? ''}
      revealed={!!revealedFields[`${row.id}:${envVar}`]}
      onReveal={() => onToggleReveal(row.id, envVar)}
      onValueChange={onValueChange}
      trailing={
        savedAndIdle ? (
          /* EVERY saved field gets the check and the remove, not just the last
             one. They rode `index === envVars.length - 1` along with the status
             glyph, which is right for the glyph and wrong for these: Bedrock
             then showed two stored fields of which only the lower one looked
             stored and only the lower one could be cleared. The check is a
             per-field report ("this one is filled in"), so it belongs on each
             field. Remove is provider-wide — one credential, one delete — and
             is offered wherever the check is, so the row you are looking at is
             always the row you can act on. */
          <>
            <span
              role="status"
              title={tI18nComplete.raw('texta45a97cbb780')}
              aria-label={tI18nComplete.raw('texta45a97cbb780')}
              className="flex shrink-0 items-center"
            >
              <Check className="text-kortix-green size-3.5 shrink-0" weight="fill" />
            </span>
            {onRemoveKey && (
              <InputGroupButton
                size="icon-xs"
                onClick={() => onRemoveKey(row.id)}
                title={tI18nComplete.raw('text81c45fd9b904')}
                aria-label={tI18nComplete('textaffe5438ae14', { value0: row.label })}
                className="text-muted-foreground/60 hover:text-destructive"
              >
                <Remove className="size-3.5" />
              </InputGroupButton>
            )}
          </>
        ) : index === row.envVars.length - 1 ? (
          // The save status DOES ride the last field only: one save covers the
          // whole provider, so one indicator reports it, and the last field is
          // where focus was when it fired.
          <KeyStatusGlyph status={status} />
        ) : undefined
      }
    />
  ));

  return (
    <div
      // Focus leaving this GROUP is the save. `relatedTarget` is what is
      // receiving focus, so tabbing between a provider's own fields — or
      // clicking its reveal button — is contained and commits nothing. `null`
      // (focus left the document entirely) is deliberately NOT contained:
      // clicking away to another window should still save what you pasted.
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        onCommit(row.id);
      }}
      className={cn('min-w-0 space-y-1.5', className)}
    >
      {row.envVars.length === 1 ? (
        fields
      ) : (
        // One border around the stack, `divide-y` for the seams — Bedrock's
        // three fields are one credential, so they get one box.
        <div className="border-border divide-border bg-background divide-y overflow-hidden rounded-md border">
          {fields}
        </div>
      )}
      {status === 'error' && errorMessage && (
        <p className="text-destructive text-xs text-pretty">{errorMessage}</p>
      )}
      {children}
    </div>
  );
}

/** Provider identity and its connection action share one row in catalog order. */
function ProviderRow({
  row,
  values,
  onValueChange,
  onCommit,
  status,
  errorMessage,
  canWrite,
  revealedFields,
  onToggleReveal,
  onRemoveKey,
  subscriptionSlot,
  accessSlot,
  wrapCredentials,
  onOpenModels,
}: {
  row: ProviderConnectRow;
  values: Record<string, string>;
  onValueChange: ProviderConnectViewProps['onValueChange'];
  onCommit: ProviderConnectViewProps['onCommit'];
  status: ProviderKeyStatus;
  errorMessage?: string;
  canWrite: boolean;
  revealedFields: Record<string, boolean>;
  onToggleReveal: ProviderConnectViewProps['onToggleReveal'];
  onRemoveKey?: ProviderConnectViewProps['onRemoveKey'];
  subscriptionSlot?: ReactNode;
  accessSlot?: ReactNode;
  wrapCredentials?: ProviderConnectViewProps['wrapCredentials'];
  onOpenModels?: (providerId: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const identity = (
    <div className="flex min-w-0 items-start gap-2.5">
      <ProviderLogo providerID={row.id} name={row.label} size="small" />
      <div className="min-w-0 pt-0.5">
        <div className="flex min-w-0 items-center gap-1">
          <span className="text-foreground truncate text-sm">{row.label}</span>
          {row.helpUrl && (
            <a
              href={row.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={tI18nComplete('text2a94ea8db704', { value0: row.label })}
              aria-label={tI18nComplete('text2a94ea8db704', { value0: row.label })}
              className="text-muted-foreground/50 hover:text-foreground shrink-0 transition-colors"
            >
              <ExternalLink className="size-3.5 shrink-0" />
            </a>
          )}
          {accessSlot}
        </div>
        {onOpenModels && row.modelCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenModels(row.id)}
            className="text-muted-foreground/50 hover:text-foreground mt-0.5 cursor-pointer text-xs tabular-nums underline underline-offset-2 transition-colors"
          >
            {row.modelCount} {tI18nComplete.raw('text9372c470eead')}
            {row.modelCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </div>
  );

  // Shared credentials require project write access. The scope wrapper can still
  // offer a reader their own personal connection without exposing shared fields.
  if (!canWrite && !wrapCredentials) {
    return (
      <div className="py-1.5" data-provider-row={row.id}>
        {identity}
      </div>
    );
  }

  const fields = canWrite ? (
    <ProviderKeyFields
      row={row}
      values={values}
      onValueChange={onValueChange}
      onCommit={onCommit}
      status={status}
      errorMessage={errorMessage}
      revealedFields={revealedFields}
      onToggleReveal={onToggleReveal}
      onRemoveKey={onRemoveKey}
    >
      {subscriptionSlot}
    </ProviderKeyFields>
  ) : null;

  return (
    <div
      data-provider-row={row.id}
      className={cn(
        wrapCredentials
          ? 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2'
          : 'grid gap-1.5 py-1.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-start sm:gap-4',
      )}
    >
      {identity}
      {wrapCredentials ? wrapCredentials(row, fields) : fields}
    </div>
  );
}

/**
 * The save's whole visual report, inside the field it belongs to.
 *
 * It lives in the input's trailing addon rather than as a line underneath
 * because a line that appears and disappears changes the row's height, and a
 * list of forty rows that twitches every time one of them saves is worse than
 * no feedback at all. Here the glyph occupies a slot the eye is already on and
 * the row never moves.
 */
function KeyStatusGlyph({ status }: { status: ProviderKeyStatus }) {
  if (status === 'idle') return null;
  // `role="status"` so a screen reader is told the save happened at all —
  // with no button to change label, the glyph is the only announcement.
  // `title` rather than `Hint` for the same provider-tree reason as the reveal
  // button above.
  const label = status === 'saving' ? 'Saving' : status === 'saved' ? 'Saved' : 'Could not save';
  return (
    <span role="status" title={label} aria-label={label} className="flex shrink-0 items-center">
      {status === 'saving' && <Loading className="size-3.5 shrink-0" />}
      {status === 'saved' && (
        <Check className="text-kortix-green size-3.5 shrink-0" weight="fill" />
      )}
      {status === 'error' && (
        <Warning className="text-kortix-red size-3.5 shrink-0" weight="fill" />
      )}
    </span>
  );
}

/**
 * Presentational only — no hooks, no fetching. Kept separate from
 * `ProviderConnect` so it renders under `renderToStaticMarkup`; every slot
 * defaults to `undefined` so the bare view needs no provider tree.
 *
 * ## One list. No sections.
 *
 * A search field, one line of instruction, rows, and a `Load more` under them.
 * That is the entire screen. See the file header for the four sections this
 * replaced, for why "three rows unless you search" was not a smaller version
 * of the same list but a different (wrong) answer to "which providers can I
 * use?", and for why paging the rows is not a return to it.
 */
export function ProviderConnectView({
  rows,
  totalCount,
  hiddenCount = 0,
  onLoadMore,
  values,
  onValueChange,
  onCommit,
  statuses,
  errors,
  revealedFields,
  onToggleReveal,
  onRemoveKey,
  canWrite,
  search,
  onSearchChange,
  subscriptionSlots,
  accessSlots,
  wrapCredentials,
  instruction,
  onOpenModels,
  className,
}: ProviderConnectViewProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className={cn('flex flex-col gap-4 px-5 py-5', className)}>
      <InputGroupSearch data-provider-search="">
        <InputGroupSearchIcon>
          <Search />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          type="text"
          // The count is the list's own size, stated where you would narrow
          // it. Every one of those providers is rendered below.
          placeholder={tI18nComplete('textbcace0f3244e', { value0: totalCount })}
          autoComplete="off"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <InputGroupSearchClear onClick={() => onSearchChange('')} />
      </InputGroupSearch>

      {/* The one sentence on the screen. With no Connect button, this is the
          only thing telling a reader their key will be written at all — an
          auto-save nobody is told about is indistinguishable from an edit that
          was lost. */}
      <p className="text-muted-foreground px-0.5 text-xs text-pretty">
        {instruction ??
          (canWrite
            ? tI18nComplete.raw('text9253b4fa8e06')
            : tI18nComplete.raw('text30674c348b84'))}
      </p>

      {rows.length === 0 ? (
        <EmptyState size="sm" title={tI18nComplete('text688e27c94de1', { value0: search })} />
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => (
            <ProviderRow
              key={row.id}
              row={row}
              values={values}
              onValueChange={onValueChange}
              onCommit={onCommit}
              status={statuses?.[row.id] ?? 'idle'}
              errorMessage={errors?.[row.id]}
              canWrite={canWrite}
              revealedFields={revealedFields ?? {}}
              onToggleReveal={onToggleReveal}
              onRemoveKey={onRemoveKey}
              subscriptionSlot={subscriptionSlots?.[row.id]}
              accessSlot={accessSlots?.[row.id]}
              wrapCredentials={wrapCredentials}
              onOpenModels={onOpenModels}
            />
          ))}
        </div>
      )}

      {/* A page at a time, with the remainder stated. This is NOT the "Show 181
          more providers" disclosure this screen deleted: that was a closed door
          with a number on it, and behind it was the whole catalogue and the
          only way to reach any of it. This is the bottom of a list that is
          already rendering providers, it says how many of how many, and the
          search above it reaches all 184 whether or not this button is ever
          pressed. */}
      {hiddenCount > 0 && onLoadMore ? (
        <div className="flex items-center justify-center gap-3 pt-1" data-provider-load-more="">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            {tI18nComplete.raw('textac8991ef0101')}
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {rows.length} {tI18nComplete.raw('text28391d3bc64e')} {rows.length + hiddenCount}
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

/**
 * How many providers render before `Load more`, and how many each press adds.
 *
 * 12, because the list leads with the three first-class ids and 12 is the point
 * where a screen's worth of rows stops being a list and starts being a scroll:
 * ~9 rows past the ones almost everybody wants, enough that OpenRouter, Vercel
 * AI Gateway, GitHub Copilot, Groq and xAI are all on the page without a
 * click, and short enough that Costs, Routing and Logs are still one flick
 * away. 184 rows rendered unconditionally — the previous behaviour — put ~172
 * providers nobody asked for between the reader and the bottom of the page.
 *
 * A batch, not "reveal everything": one press that dumps the remaining 172
 * rebuilds the wall this screen removed. The search field, not this button, is
 * how you reach a provider deep in the catalogue, and it searches all of it.
 */
export const PROVIDER_PAGE_SIZE = 12;

function toRow(entry: LlmProviderEntry, connectedIds: Set<string>): ProviderConnectRow {
  return {
    id: entry.id,
    label: entry.label,
    note: PROVIDER_NOTES[entry.id] ?? entry.hint,
    envVars: entry.envVars,
    helpUrl: entry.helpUrl,
    connected: connectedIds.has(entry.id),
    modelCount: entry.models.length,
    placeholders: Object.fromEntries(
      entry.envVars.map((envVar) => [envVar, envVarPlaceholder(entry, envVar)]),
    ),
  };
}

export interface ProviderConnectProps {
  projectId: string;
  /** Same value the deleted modal body took — see `ProviderConnectViewProps`. */
  canWrite?: boolean;
  /** Set while this surface is visible; drives the underlying queries. */
  enabled?: boolean;
  onOpenModels?: (providerId: string) => void;
  className?: string;
}

export function ProviderConnect({
  projectId,
  canWrite = false,
  enabled = true,
  onOpenModels,
  className,
}: ProviderConnectProps) {
  const tPersonal = useTranslations('personalProviders');
  const tAccess = useTranslations('modelAccess');
  const access = useModelAccess(enabled ? projectId : null);
  const pickerCatalog = useProjectModelPickerCatalog(enabled ? projectId : null);
  useLiveLlmProviderCatalog(projectId, enabled);
  const catalogRevision = useLlmProviderCatalogRevision();
  const { connectedProviders, providerStateLoading } = useConnectedProviders(projectId, enabled);
  const [search, setSearch] = useState('');

  const connectedIds = useMemo(
    () => new Set(connectedProviders.map((provider) => provider.id)),
    [connectedProviders],
  );

  // The revision subscription above re-renders this component after the live
  // catalog replaces the module binding.
  const managedProvider = useMemo<LlmProviderEntry>(
    () => ({
      id: 'kortix',
      label: 'Kortix',
      envVars: [],
      authRequirement: { methods: [] },
      helpUrl: null,
      apiHost: null,
      hint: tAccess('managedDescription'),
      models: Object.entries(pickerCatalog?.models ?? {})
        .filter(([id]) => !id.includes('/'))
        .map(([id, model]) => ({
          id,
          name: model.name || id,
          description: model.description,
          reasoning: model.reasoning,
          tool_call: model.tool_call,
          attachment: model.attachment,
          limit: model.limit,
          cost: model.cost,
        })),
      featured: true,
      managed: true,
    }),
    [pickerCatalog, tAccess],
  );
  const searchable = useMemo(
    () => [
      ...(access.data?.enforced ? [managedProvider] : []),
      ...LLM_PROVIDERS.filter((provider) => provider.id !== 'kortix'),
    ],
    // The module catalog changes out of band. Its revision triggers a fresh read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [access.data?.enforced, managedProvider, catalogRevision],
  );

  /**
   * THE list, in a FIXED order that a save never disturbs — see
   * `orderProviderRows` in `utils.ts`, where the ordering rule is pure and its
   * invariants are pinned by tests. This only maps the result into row props.
   */
  const rows = useMemo(
    () =>
      orderProviderRows({
        providers: searchable,
        firstClassIds: ['kortix', ...FIRST_CLASS_PROVIDER_IDS],
        connectedIds,
        search,
      }).map((entry) => toRow(entry, connectedIds)),
    [search, searchable, connectedIds],
  );

  /**
   * Pagination and search are INDEPENDENT, and search wins.
   *
   * A query is a request for its matches — all of them — so it renders the
   * whole match set whatever the window happens to be. `Load more` between a
   * reader and the provider they just typed the name of would be the disclosure
   * this screen deleted, wearing a different label.
   */
  const [visibleCount, setVisibleCount] = useState(PROVIDER_PAGE_SIZE);
  const searching = search.trim().length > 0;
  /**
   * A stored key is never behind `Load more`. The order is fixed catalogue
   * order and never hoists a connected provider (`orderProviderRows` —
   * hoisting is the row-teleport defect this list exists to prevent), so a key
   * on provider #58 sits past the window. The window stretches to reach it
   * instead: the rows before it come too, and nothing moves.
   */
  const lastConnectedIndex = useMemo(
    () => rows.reduce((last, row, index) => (row.connected ? index : last), -1),
    [rows],
  );
  const limit = searching ? rows.length : Math.max(visibleCount, lastConnectedIndex + 1);
  const visibleRows = useMemo(() => rows.slice(0, limit), [rows, limit]);
  const hiddenCount = rows.length - visibleRows.length;

  return (
    <>
      <ProviderConnectView
        accessSlots={Object.fromEntries(
          visibleRows.map((row) => [
            row.id,
            <div key={row.id} className="flex shrink-0 items-center gap-0.5">
              <ProviderAccessMenu
                access={access}
                providerId={row.id}
                name={row.id === 'kortix' ? tAccess('managedTitle') : row.label}
                canWrite={canWrite}
              />
              {row.id === 'openai' && (
                <ProviderAccessMenu
                  access={access}
                  providerId="codex"
                  name="ChatGPT subscription"
                  canWrite={canWrite}
                />
              )}
            </div>,
          ]),
        )}
        className={className}
        rows={visibleRows}
        instruction={tPersonal('listInstruction')}
        wrapCredentials={(row) =>
          row.id === 'kortix' ? null : (
            <ProjectProviderConnection
              projectId={projectId}
              row={row}
              canWrite={canWrite}
              projectConnectionsLoading={providerStateLoading}
              subscriptionConnected={row.id === 'openai' && connectedIds.has('codex')}
              KeyFields={ProviderKeyFields}
            />
          )
        }
        totalCount={searchable.length}
        hiddenCount={hiddenCount}
        onLoadMore={() => setVisibleCount((shown) => shown + PROVIDER_PAGE_SIZE)}
        values={{}}
        onValueChange={() => {}}
        onCommit={() => {}}
        onToggleReveal={() => {}}
        canWrite={canWrite}
        search={search}
        onSearchChange={setSearch}
        onOpenModels={access.data?.enforced ? onOpenModels : undefined}
      />
    </>
  );
}
