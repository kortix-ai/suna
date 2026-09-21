import { DEFAULT_MANAGED_MODEL_IDS, PROVIDER_LABELS } from '@kortix/llm-catalog';

import type { FlatModel } from './session-chat-input';

const MANAGED_MODEL_IDS = new Set<string>(DEFAULT_MANAGED_MODEL_IDS);

// The gateway exposes its whole catalog through a single `kortix` provider, with
// model ids namespaced as `<provider>/<model>`. For the picker we recover the
// REAL provider: platform-managed defaults stay under the "Kortix" group, while
// every BYOK model surfaces under its real provider ("Anthropic", "OpenAI", …) —
// so a connected provider reads as its own section, not buried in Kortix.
//
// *** BUG THIS FIXES (every model showing under "Kortix", even BYOK Anthropic) ***
// `pickerGroupId` always correctly computed the grouping KEY (it split
// `modelID` on "/" and returned e.g. "anthropic"). The bug was never in the
// key — it was that the group's DISPLAY NAME, built in `grouped` below, was
// taken verbatim from `model.providerName` (opencode's raw provider name,
// which is ALWAYS "Kortix" — every gateway model is registered under the one
// synthetic `kortix` opencode provider). So the group's icon rendered
// correctly (`ProviderLogo` is keyed off the correct `providerID`), but the
// text label next to it always read "Kortix" regardless of which provider
// actually served the model.
//
// The robust fix (per the live /v1/models trace): the gateway now serves an
// EXPLICIT `provider` field per model (`GatewayModel.provider`, threaded onto
// `FlatModel.provider` by flattenModels) — grouping/labeling should prefer
// that over parsing the wire id at all. String-splitting `modelID` remains
// ONLY as a fallback for a stale/older baked catalog that predates the field.
export function pickerGroupId(model: FlatModel): string {
  if (model.providerID !== 'kortix') {
    return model.providerID;
  }
  if (MANAGED_MODEL_IDS.has(model.modelID)) return model.provider ?? model.providerID;
  if (model.provider) return model.provider;
  const slash = model.modelID.indexOf('/');
  return slash === -1 ? model.providerID : model.modelID.slice(0, slash);
}

// The group's display name/label — NEVER the raw `FlatModel.providerName`
// (always "Kortix" under the gateway, see the bug note above). Prefer the
// canonical label for the resolved real-provider id; only fall back to the
// model's own providerName for a truly unknown id (e.g. `pickerGroupId`
// degrading to the raw `providerID` because neither `provider` nor a `/` was
// present — at that point `groupID === model.providerID` anyway).
export function pickerGroupLabel(groupID: string, model: FlatModel): string {
  return PROVIDER_LABELS[groupID] ?? model.providerName;
}

/**
 * The `value` cmdk keys a picker row by.
 *
 * The account default renders TWICE — once pinned in its own section at the
 * top, once in the provider group it belongs to — and cmdk drives filtering,
 * keyboard navigation and `data-selected` off this string. Two rows sharing one
 * value is a SILENT failure: arrow-key navigation lands on both, the highlight
 * jumps, and nothing errors. The scope prefix is what keeps them distinct, so
 * it goes through here rather than being interpolated at each call site.
 */
export function modelItemValue(
  scope: 'pinned' | 'model',
  model: Pick<FlatModel, 'providerID' | 'modelID'>,
): string {
  return `${scope}-${model.providerID}-${model.modelID}`;
}

/**
 * A model name split into the part that carries the weight and the part that
 * qualifies it, so the picker can render one line in two tones instead of two
 * lines ("Opus" bold + "5" muted, rather than "Opus 5" over "anthropic/opus-5").
 *
 *   'Opus 5'          → { lead: 'Opus',    trail: '5' }
 *   'GPT-5.6 Sol'     → { lead: 'GPT-5.6', trail: 'Sol' }
 *   'Claude Sonnet 5' → { lead: 'Claude',  trail: 'Sonnet 5' }
 *   'Sonnet'          → { lead: 'Sonnet',  trail: '' }
 *
 * Splits on the FIRST whitespace run only. A three-word name keeps everything
 * after the first word together rather than breaking somewhere arbitrary in
 * the middle, and a name with no space stays entirely in `lead` — never an
 * empty bold half with the whole name greyed out.
 */
export function splitModelLabel(modelName: string | undefined): {
  lead: string;
  trail: string;
} {
  const trimmed = (modelName ?? '').trim();
  const match = /^(\S+)\s+(.*)$/.exec(trimmed);
  if (!match) return { lead: trimmed, trail: '' };
  return { lead: match[1], trail: match[2].trim() };
}

/**
 * Whether a provider section renders its models or a single "expand" row.
 *
 * The picker opened as one long list: 8 managed models, then every connected
 * provider's, then one row per subscription model — and with two ChatGPT
 * accounts connected that list doubles again. Almost every session uses a
 * managed model, so the rest is scrolling the user pays for on every open.
 *
 * Collapsed by default, with four exceptions that each exist because the
 * alternative is a picker that looks broken:
 *
 *  1. SEARCH. A query must reach every provider — a collapsed group that hides
 *     a match reads as "the model is gone", which is the bug this picker had
 *     once already.
 *  2. THE FIRST GROUP. `MODEL_SELECTOR_PROVIDER_IDS` puts `kortix` first, so
 *     this is the managed set: the models most sessions use, always open. On a
 *     BYOK-only project there is no kortix group and this keeps the picker from
 *     opening fully collapsed.
 *  3. THE SELECTED MODEL'S GROUP. Opening the picker must always show what you
 *     are currently on, or the check mark has nowhere to live.
 *  4. What the user expanded by hand, this time the popover was open.
 */
export function isPickerGroupOpen(input: {
  groupIndex: number;
  groupProviderID: string;
  hasSearch: boolean;
  containsSelected: boolean;
  expanded: ReadonlySet<string>;
}): boolean {
  if (input.hasSearch) return true;
  if (input.groupIndex === 0) return true;
  if (input.containsSelected) return true;
  return input.expanded.has(input.groupProviderID);
}

/** One collapsible section in the picker: a heading and the models under it. */
export interface PickerSection {
  /** Stable key for expand state and for cmdk values. */
  id: string;
  /** The RESOLVED provider (`pickerGroupId`) — what the row's logo keys on.
   *  Never `model.providerID`, which is `kortix` for every gateway model. */
  providerID: string;
  /** The heading: the provider's name. */
  label: string;
  models: FlatModel[];
  /** Credentials connected for this provider. Empty for most providers. */
  accounts: PickerAccount[];
  /** The credential currently pinned, or null for the project default. */
  activeSecretId: string | null;
}

/** The subset of an account secret resource the picker needs. */
export interface PickerAccount {
  secret_id: string;
  label: string;
  provider_id: string | null;
  /** False when this viewer holds no grant on the credential. */
  can_use?: boolean;
  /** False once the credential is retired. */
  active?: boolean;
}

/**
 * Provider sections, each carrying the credentials connected for it.
 *
 * A ChatGPT subscription is a CREDENTIAL, not a model set: every connected
 * account exposes the SAME models. Splitting the group into one section per
 * account therefore printed the same five models twice — ten rows to express
 * five models and two credentials, and it multiplies with every account added.
 *
 * So the models are listed ONCE and the credential is a control in the heading.
 * `activeSecretId` is what the session has pinned (null = the project default),
 * supplied by the caller because only it knows whether that lives in a live
 * session's pool or in a not-yet-created session's draft.
 */
export function buildPickerSections(
  groups: readonly { providerID: string; providerName: string; models: FlatModel[] }[],
  accounts: readonly PickerAccount[],
  activeByProvider: Readonly<Record<string, string | null>> = {},
): PickerSection[] {
  return groups.map((group) => {
    // Offer only what the write would accept. `PUT .../provider-secret-pools`
    // rejects a credential this viewer holds no grant on, and an inactive one,
    // with 403 — so listing either would be a choice that fails on click.
    const mine = accounts.filter(
      (a) => a.provider_id === group.providerID && a.can_use !== false && a.active !== false,
    );
    const active = activeByProvider[group.providerID] ?? null;
    return {
      id: group.providerID,
      providerID: group.providerID,
      label: group.providerName,
      models: group.models,
      accounts: mine,
      // A pin naming a credential that is gone must not survive as a claim.
      activeSecretId: mine.some((a) => a.secret_id === active) ? active : null,
    };
  });
}
