'use client';

/**
 * `provider-connect.tsx` — THE provider connect surface. One component, mounted
 * by the Models settings tab (`gateway-view.tsx`'s Providers sub-tab, reached
 * through `features/workspace/settings/tabs/models-tab.tsx`), by the model
 * selector's connect dialog and by the Secrets tab's "Manage providers" button
 * (both through `llm-provider-modal.tsx`'s `ProjectProviderModal`, which is now
 * only a `Modal` shell around this file). JAY-510: a third copy is not
 * acceptable — that is the defect this file exists to remove.
 *
 * **ONE list. No sections. EVERY provider.** A search field, one line of
 * instruction, and a row per provider — logo and name on the left, key field
 * on the right. That is the whole screen.
 *
 * **What this replaced, and why.** It had four sections — Connected, Add a
 * key, a "Show 181 more providers" disclosure, and Custom provider — each
 * individually defensible and collectively unreadable. Three concrete
 * failures, all fixed by deleting structure rather than relabelling it:
 *
 *   1. *The row teleported.* Saving a key moved that provider out of the grid
 *      into a "Connected" block ABOVE it, growing a section that was not there
 *      a second earlier. Order is now fixed; a saved row gains a check and
 *      stays put.
 *   2. *The same provider appeared twice* — once as a connected summary with a
 *      "Replace key" button, once as an empty field. Now one row, and typing
 *      in it IS replacing.
 *   3. *"Show 181 more providers" was a wall,* not an invitation.
 *
 * The first cut of (3) deleted the disclosure AND the providers behind it:
 * with no search text the list was the three first-class ids plus whatever
 * already had a key, so 185 providers only existed for someone who typed a
 * name they already knew. That reads as "Kortix supports three providers".
 * The whole catalog now renders (`orderProviderRows`), first-class ids first,
 * everything else in catalog order — the search field narrows a list that is
 * already all there instead of being the only door to it.
 *
 * Custom providers moved out entirely, to their own tab
 * (`custom-provider-panel.tsx`) — a job almost nobody does should not be the
 * last thing on the screen everybody uses.
 *
 * **Anthropic's subscription half has no control — deliberate, disclosed.**
 * `PROVIDER_NOTES.anthropic` reads "Claude Pro/Max subscription or your own API
 * key", but there is no Anthropic OAuth anywhere in this repo: the only live
 * provider OAuth is `startProjectProviderOAuth(projectId, 'openai', ...)`
 * (`chatgpt-subscription-connect.tsx:58`). The note renders verbatim because
 * JAY-510 requires it; the missing flow is a product gap, not something this
 * file may invent. OpenAI's subscription half IS real and mounts as
 * `subscriptionSlots.openai`.
 *
 * **Layers.** `ProviderConnectView` is pure (props only, no hooks) so it renders
 * under `renderToStaticMarkup` with no `QueryClientProvider` — the repo's only
 * render-assertion idiom. `ProviderConnect` is the container and owns every
 * hook. Same split as `sandbox-tab.tsx` / `models-tab.tsx`.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { PROVIDER_NOTES, ProviderLogo } from '@/features/providers/provider-branding';
import { ChatGptSubscriptionConnect } from '@/features/workspace/customize/sections/llm-provider/chatgpt-subscription-connect';
import { ProviderDetail } from '@/features/workspace/customize/sections/llm-provider/provider-detail';
import { useConnectedProviders } from '@/features/workspace/customize/sections/llm-provider/use-connected-providers';
import {
  envVarPlaceholder,
  orderProviderRows,
  prettyFieldLabel,
  providerDisconnectPlan,
  shouldSaveCredential,
} from '@/features/workspace/customize/sections/llm-provider/utils';
import { LLM_PROVIDERS, LLM_PROVIDER_BY_ID, type LlmProviderEntry } from '@/lib/llm-providers';
import { cn } from '@/lib/utils';
import { focusWithoutScroll } from '@/lib/utils/focus-without-scroll';
import { deleteProjectProviderOAuth, deleteProjectSecret, upsertProjectSecret } from '@kortix/sdk';
import { qk, refreshProjectProviderState } from '@kortix/sdk/react';
import {
  CheckCircleIcon as Check,
  ArrowSquareOutIcon as ExternalLink,
  EyeIcon as Eye,
  EyeSlashIcon as EyeSlash,
  XIcon as Remove,
  MagnifyingGlassIcon as Search,
  PlugsIcon as Unplug,
  WarningCircleIcon as Warning,
} from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

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
 * The DOM id of one credential input. Defined once because two places must
 * agree on it: the row that renders the field, and `ProviderDetail`'s Connect
 * button, which closes the detail and focuses that field.
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
  /** How many providers exist in total. Equals `rows.length` until a search
   *  narrows the list, and is what the search placeholder counts. */
  totalCount: number;
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
  /**
   * "Browse before you connect". When set, `detailSlot` REPLACES the list —
   * the one capability the deleted `CatalogTab` drill-down had that an inline
   * row does not.
   */
  detailProviderId?: string | null;
  onOpenDetail?: (providerId: string | null) => void;
  detailSlot?: ReactNode;
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
   */
  const placeholder =
    row.connected && !value
      ? 'Saved — paste a new key to replace it'
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
              aria-label={revealed ? `Hide ${row.label} key` : `Show ${row.label} key`}
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
  const untouched = row.envVars.every((envVar) => !values[`${row.id}:${envVar}`]);
  const fields = row.envVars.map((envVar, index) => (
    <CredentialField
      key={envVar}
      row={row}
      envVar={envVar}
      value={values[`${row.id}:${envVar}`] ?? ''}
      revealed={!!revealedFields[`${row.id}:${envVar}`]}
      onReveal={() => onToggleReveal(row.id, envVar)}
      onValueChange={onValueChange}
      // The trailing controls ride the LAST field: they report the provider's
      // one save, and the last field is where focus was when it fired.
      trailing={
        index === row.envVars.length - 1 ? (
          <>
            {/* A saved, untouched row reports itself with a check — and offers
                the only destructive action on this screen, right where the key
                is. It used to take a separate "Connected" section with its own
                "Replace key" and unplug buttons to say the same thing. */}
            {row.connected && untouched && status === 'idle' ? (
              <>
                <span
                  role="status"
                  title="Key saved"
                  aria-label="Key saved"
                  className="flex shrink-0 items-center"
                >
                  <Check className="text-kortix-green size-3.5 shrink-0" weight="fill" />
                </span>
                {onRemoveKey && (
                  <InputGroupButton
                    size="icon-xs"
                    onClick={() => onRemoveKey(row.id)}
                    title="Remove key"
                    aria-label={`Remove the ${row.label} key`}
                    className="text-muted-foreground/60 hover:text-destructive"
                  >
                    <Remove className="size-3.5" />
                  </InputGroupButton>
                )}
              </>
            ) : (
              <KeyStatusGlyph status={status} />
            )}
          </>
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
        <div className="border-border divide-border dark:bg-input/30 divide-y overflow-hidden rounded-md border">
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

/**
 * One provider, as a two-column row: who it is on the left, where the key goes
 * on the right.
 *
 * ## Why the grid, and not the card it replaced
 *
 * Every row used to be a bordered card holding a logo, a title, a badge, a
 * subtitle, a "Get a key" link, a model-count link, a labelled input and a
 * Connect button — eight things, boxed, stacked forty deep. Nothing lined up
 * vertically, so the eye had to re-find the input on every row.
 *
 * Here the fields share one column, so all forty inputs sit on one axis and
 * the page can be scanned by moving straight down it. The chrome that carried
 * no information — the per-row border, the key glyph in the field, the "Get a
 * key" words around the link — is gone; the link survives as the `↗` beside
 * the name, which is where a reader already looks for "take me to it".
 *
 * ## No Connect button
 *
 * The button is gone because the row can tell when you are done with it: the
 * save fires when focus LEAVES the row (`onBlur` + a `relatedTarget` containment
 * check), which is one save per provider no matter how many fields it has, and
 * fires exactly once whether you tab out, click elsewhere, or press Enter.
 * `onCommit` decides whether that is actually a write — see `ProviderConnect`.
 */
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
  onOpenDetail,
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
  onOpenDetail?: (providerId: string) => void;
}) {
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
              title={`Where to get a ${row.label} key`}
              aria-label={`Where to get a ${row.label} key`}
              className="text-muted-foreground/50 hover:text-foreground shrink-0 transition-colors"
            >
              <ExternalLink className="size-3.5 shrink-0" />
            </a>
          )}
        </div>
        {onOpenDetail && row.modelCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenDetail(row.id)}
            className="text-muted-foreground/50 hover:text-foreground mt-0.5 cursor-pointer text-xs tabular-nums underline underline-offset-2 transition-colors"
          >
            {row.modelCount} model{row.modelCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </div>
  );

  // Read-only members get the identity column and nothing else — no field to
  // type in, so no second column to line it up against either.
  if (!canWrite) {
    return (
      <div className="py-1.5" data-provider-row={row.id}>
        {identity}
      </div>
    );
  }

  return (
    <div
      data-provider-row={row.id}
      className="grid gap-1.5 py-1.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-start sm:gap-4"
    >
      {identity}
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
 * ## One list. No sections. Every provider.
 *
 * A search field, one line of instruction, and rows — all of them. That is
 * the entire screen. See the file header for the four sections this replaced
 * and for why "three rows unless you search" was not a smaller version of
 * the same list, it was a different (wrong) answer to "which providers can I
 * use?".
 */
export function ProviderConnectView({
  rows,
  totalCount,
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
  detailProviderId = null,
  onOpenDetail,
  detailSlot,
  className,
}: ProviderConnectViewProps) {
  if (detailProviderId && detailSlot) {
    return <div className={cn('px-5 py-5', className)}>{detailSlot}</div>;
  }

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
          placeholder={`Search ${totalCount} providers…`}
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
        {canWrite
          ? 'Paste a key — it saves when you click away. Everyone on this project can use it.'
          : 'Ask an owner of this project to add a key — you have read-only access.'}
      </p>

      {rows.length === 0 ? (
        <EmptyState size="sm" title={`No provider matches "${search}"`} />
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
              onOpenDetail={onOpenDetail}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

const CONNECTION_REFRESH_TIMEOUT_MS = 45_000;

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
  className?: string;
}

export function ProviderConnect({
  projectId,
  canWrite = false,
  enabled = true,
  className,
}: ProviderConnectProps) {
  const { connectedProviders, providerStateLoading } = useConnectedProviders(projectId, enabled);
  const queryClient = useQueryClient();

  const [values, setValues] = useState<Record<string, string>>({});
  const [revealedFields, setRevealedFields] = useState<Record<string, boolean>>({});
  /**
   * What each `${providerId}:${envVar}` held the last time it was successfully
   * saved. This — not a dirty flag — is what stops the blur-driven save from
   * re-POSTing an unchanged key every time focus crosses a row. A flag would
   * have to be cleared by hand from four places; a snapshot answers "did this
   * change" by comparison and cannot fall out of sync.
   */
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  // The connect we are waiting on. The VISIBLE pending flag is DERIVED from it
  // below rather than cleared from inside an effect — that synchronous
  // `setState` in an effect body is what `react-hooks/set-state-in-effect`
  // flags, and it cost an extra render too.
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  const [detailProviderId, setDetailProviderId] = useState<string | null>(null);
  const detailEntry = detailProviderId ? (LLM_PROVIDER_BY_ID.get(detailProviderId) ?? null) : null;

  const connectedIds = useMemo(
    () => new Set(connectedProviders.map((provider) => provider.id)),
    [connectedProviders],
  );

  // Pending ends the moment the provider shows up in the connected list.
  // `pendingRequest` is additionally cleared on a disconnect, so connecting X
  // and later disconnecting X cannot revive a stale spinner on that row.
  const pendingProviderId =
    pendingRequest && !connectedIds.has(pendingRequest) ? pendingRequest : null;

  const searchable = useMemo(
    () => LLM_PROVIDERS.filter((provider) => provider.id !== 'kortix'),
    [],
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
        firstClassIds: FIRST_CLASS_PROVIDER_IDS,
        connectedIds,
        search,
      }).map((entry) => toRow(entry, connectedIds)),
    [search, searchable, connectedIds],
  );

  const connect = useMutation({
    mutationFn: async (providerId: string) => {
      const entry = LLM_PROVIDER_BY_ID.get(providerId);
      if (!entry) throw new Error(`Unknown provider ${providerId}`);
      // LLM provider credentials are ALWAYS project-wide — a per-user key is
      // invisible to the gateway's shared-row resolution and every model turn
      // dies with "No upstream configured" (2026-07-07 prod incident). Ported
      // verbatim from the deleted `api-key-connect-form.tsx:52-62`.
      await Promise.all(
        entry.envVars.map((envVar) =>
          upsertProjectSecret(projectId, {
            name: envVar,
            value: (values[`${providerId}:${envVar}`] ?? '').trim(),
            strategy: 'broker',
            consumer: 'llm_gateway',
          }),
        ),
      );
      return entry;
    },
    onSuccess: (entry) => {
      successToast(`${entry.label} key saved`);
      // The typed values are KEPT, and recorded as the saved baseline. Clearing
      // them was right when a Connect button ended the interaction; with a
      // blur-driven save the field is still on screen and still focusable, and
      // a field that empties itself the instant you click away reads as "it
      // threw my key away", not as "it saved".
      setSavedValues((current) => {
        const next = { ...current };
        for (const envVar of entry.envVars) {
          const key = `${entry.id}:${envVar}`;
          next[key] = (values[key] ?? '').trim();
        }
        return next;
      });
      setErrors((current) => {
        if (!(entry.id in current)) return current;
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      setPendingRequest(entry.id);
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      refreshProjectProviderState(queryClient, projectId, { expectProviderId: entry.id });
    },
    onError: (err, providerId) => {
      const message = err instanceof Error ? err.message : 'Failed to save credentials';
      // Both channels, deliberately. The toast is what someone who has already
      // scrolled away sees; the inline message is what stays put next to the
      // field they have to fix. A blur-driven save has no button to leave in a
      // failed state, so the row has to carry the failure itself.
      errorToast(message);
      setErrors((current) => ({ ...current, [providerId]: message }));
    },
  });

  /**
   * Removing a key. Same fan-out the deleted `ConnectedProviderList` did —
   * `providerDisconnectPlan` + `deleteProjectProviderOAuth` +
   * `deleteProjectSecret`, same invalidations — moved up here because the
   * control that triggers it now lives inside the row's own field instead of
   * in a second list that no longer exists.
   */
  const remove = useMutation({
    mutationFn: async (provider: LlmProviderEntry) => {
      const plan = providerDisconnectPlan(provider);
      await Promise.all([
        ...(plan.oauthProvider ? [deleteProjectProviderOAuth(projectId, plan.oauthProvider)] : []),
        ...plan.secretNames.map((name) => deleteProjectSecret(projectId, name)),
      ]);
      return provider;
    },
    onSuccess: (provider) => {
      successToast(`${provider.label} key removed`);
      setRemoveId(null);
      // Settle any pending connect for the same provider, and forget the saved
      // baseline — otherwise re-pasting the SAME key would compare equal and
      // `shouldSaveCredential` would decline to write it back.
      setPendingRequest(null);
      setSavedValues((current) => {
        const next = { ...current };
        for (const envVar of provider.envVars) delete next[`${provider.id}:${envVar}`];
        return next;
      });
      setValues((current) => {
        const next = { ...current };
        for (const envVar of provider.envVars) delete next[`${provider.id}:${envVar}`];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to remove the key'),
  });

  // Warn if the refresh never lands. Same contract as the deleted modal's
  // `pendingProviderId` effect (`llm-provider-modal.tsx:90-105`), minus the
  // full-surface takeover it used to render. No synchronous `setState` in the
  // effect body — the success path is the derivation above; this only writes
  // from inside the timeout callback.
  useEffect(() => {
    if (!pendingProviderId) return;
    const timeout = window.setTimeout(() => {
      setPendingRequest(null);
      warningToast('The key was saved, but the connected provider list did not refresh.');
    }, CONNECTION_REFRESH_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [pendingProviderId]);

  const handleValueChange = useCallback((providerId: string, envVar: string, value: string) => {
    setValues((current) => ({ ...current, [`${providerId}:${envVar}`]: value }));
    // Typing is the retry. Clearing the row's failure here — rather than only
    // when the next save succeeds — stops a red field from arguing with a key
    // the user has already corrected.
    setErrors((current) => {
      if (!(providerId in current)) return current;
      const next = { ...current };
      delete next[providerId];
      return next;
    });
  }, []);

  const handleToggleReveal = useCallback((providerId: string, envVar: string) => {
    setRevealedFields((current) => {
      const key = `${providerId}:${envVar}`;
      return { ...current, [key]: !current[key] };
    });
  }, []);

  /**
   * "Focus left this provider's row." Whether that is a WRITE is
   * `shouldSaveCredential`'s call — a pure predicate in `utils.ts`, where its
   * three rules (nothing typed / half a credential / unchanged) are pinned by
   * tests instead of living inside a callback nothing can reach.
   */
  const handleCommit = useCallback(
    (providerId: string) => {
      const entry = LLM_PROVIDER_BY_ID.get(providerId);
      if (!entry) return;
      if (!shouldSaveCredential({ providerId, envVars: entry.envVars, values, savedValues })) {
        return;
      }
      connect.mutate(providerId);
    },
    [connect, values, savedValues],
  );

  /**
   * One status per provider, derived — never stored. `saving` outlives the
   * mutation on purpose: the POST returning is not the moment the provider is
   * usable, `refreshProjectProviderState` landing is, and a spinner that stops
   * before then invites a second paste into a field that is already working.
   */
  const statuses = useMemo(() => {
    const map: Record<string, ProviderKeyStatus> = {};
    for (const [key] of Object.entries(savedValues)) {
      const providerId = key.slice(0, key.indexOf(':'));
      if (providerId) map[providerId] = 'saved';
    }
    const saving = connect.isPending ? connect.variables : pendingProviderId;
    if (saving) map[saving] = 'saving';
    for (const providerId of Object.keys(errors)) map[providerId] = 'error';
    return map;
  }, [savedValues, connect.isPending, connect.variables, pendingProviderId, errors]);

  const removeEntry = removeId
    ? (connectedProviders.find((p) => p.id === removeId) ??
      LLM_PROVIDER_BY_ID.get(removeId) ??
      null)
    : null;

  if (providerStateLoading) {
    return (
      <div
        className="flex min-h-[200px] items-center justify-center"
        role="status"
        aria-label="Loading providers"
      >
        <Loading className="text-muted-foreground size-4 shrink-0" />
      </div>
    );
  }

  return (
    <>
      <ProviderConnectView
        className={className}
        rows={rows}
        totalCount={searchable.length}
        values={values}
        onValueChange={handleValueChange}
        onCommit={handleCommit}
        statuses={statuses}
        errors={errors}
        revealedFields={revealedFields}
        onToggleReveal={handleToggleReveal}
        onRemoveKey={canWrite ? setRemoveId : undefined}
        canWrite={canWrite}
        search={search}
        onSearchChange={setSearch}
        subscriptionSlots={
          canWrite
            ? {
                // The ONLY live provider subscription flow in the repo. Anthropic
                // has no OAuth anywhere — see this file's header comment.
                openai: (
                  <ChatGptSubscriptionConnect
                    projectId={projectId}
                    onConnected={setPendingRequest}
                  />
                ),
              }
            : undefined
        }
        detailProviderId={detailProviderId}
        onOpenDetail={setDetailProviderId}
        detailSlot={
          detailEntry ? (
            <ProviderDetail
              provider={detailEntry}
              isConnected={connectedIds.has(detailEntry.id)}
              canWrite={canWrite}
              onBack={() => setDetailProviderId(null)}
              // The credential field lives on the row BEHIND this detail, so
              // Connect closes the detail and puts the caret in it. A button
              // labelled "Connect" that only closes a panel is worse than none.
              // `focusWithoutScroll` per repo convention — the field sits inside
              // the panel's overflow-hidden scroller.
              onConnect={() => {
                const envVar = detailEntry.envVars[0];
                setDetailProviderId(null);
                if (!envVar) return;
                requestAnimationFrame(() =>
                  focusWithoutScroll(
                    document.getElementById(providerKeyFieldId(detailEntry.id, envVar)),
                  ),
                );
              }}
            />
          ) : undefined
        }
      />

      {/* The one destructive action on this screen. `ConfirmDialog` is mandatory
        before a delete (design system) — and the `×` sits inside a field, one
        stray click from the key it removes, so it earns the confirm twice
        over. Copy says the consequence, not the storage: the env-var names it
        used to print in `<code>` described where the key lived to a reader who
        is deciding whether to lose it. */}
      <ConfirmDialog
        open={!!removeId}
        onOpenChange={(open) => !open && setRemoveId(null)}
        title="Remove this key?"
        confirmLabel="Remove key"
        confirmVariant="destructive"
        confirmIcon={<Unplug className="size-3.5 shrink-0" />}
        isPending={remove.isPending}
        onConfirm={() => removeEntry && remove.mutate(removeEntry)}
        description={
          removeEntry ? (
            <span className="text-xs">
              This project stops being able to use{' '}
              <span className="text-foreground font-medium">{removeEntry.label}</span>
              {removeEntry.models.length > 0 && (
                <>
                  {' '}
                  and its {removeEntry.models.length} model
                  {removeEntry.models.length === 1 ? '' : 's'}
                </>
              )}
              , for everyone on it. Kortix does not keep a copy — you will need the key again to put
              it back.
            </span>
          ) : null
        }
      />
    </>
  );
}
