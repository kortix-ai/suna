/**
 * Which models a project shows by DEFAULT — the single source of truth for
 * "the latest ones", shared by the gateway (which enforces enablement) and the
 * web picker / "Manage models" tab (which render it).
 *
 * This rule used to live client-side inside `useModelStore` (packages/sdk), so
 * the server had no idea which models the picker would actually show: an admin
 * saw "15 of 15 shown in the model picker" while the picker rendered 3. It's a
 * pure function over catalog metadata, so it belongs here next to
 * `providerFlagship` — the other "which model should we pick for you" rule.
 */

/** The catalog metadata the default-set rule needs. `id` is the gateway WIRE id. */
export interface EnablementCandidate {
  /** Wire id — bare (`glm-5.3-flash`) for managed, `provider/model` for BYOK. */
  id: string;
  /** models.dev release date (`YYYY-MM-DD`). */
  released?: string | null;
  /** models.dev family/lineage grouping (e.g. `claude-4`, `gpt-sol`). */
  family?: string | null;
  /** Real upstream provider. Falls back to the wire id's `provider/` prefix. */
  provider?: string | null;
}

/** A model released within this window counts as current. */
export const DEFAULT_ENABLEMENT_WINDOW_MONTHS = 6;

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

/** Epoch ms for a models.dev date, or null when absent/unparseable. */
function releasedAt(model: EnablementCandidate): number | null {
  if (!model.released) return null;
  const ms = new Date(model.released).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The provider a model belongs to. Every gateway model is registered under the
 * one synthetic `kortix` provider, so grouping by the SERVED provider id would
 * collapse every upstream into a single bucket — prefer the explicit field and
 * fall back to the wire id's prefix (bare ids are managed, i.e. `kortix`).
 */
function providerOf(model: EnablementCandidate): string {
  if (model.provider) return model.provider;
  const slash = model.id.indexOf('/');
  return slash === -1 ? 'kortix' : model.id.slice(0, slash);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const existing = groups.get(k);
    if (existing) existing.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** The newest member of a group; ties and undated models resolve by catalog order. */
/**
 * Amazon Bedrock lists most current models three ways: the bare in-region id
 * (`openai.gpt-5.6-luna`), regional cross-region inference profiles
 * (`us.` / `eu.` / `jp.` / `apac.` / `au.`), and a `global.` profile — same
 * family, same release date. For these models Bedrock REFUSES the bare id
 * ("Invocation of model ID … with on-demand throughput isn't supported. Retry
 * your request with the ID or ARN of an inference profile"), verified live
 * 2026-08-25 on gpt-5.6-luna/terra and grok-4.6. Rank: global 2 > regional 1
 * > bare 0. A provider prefix (`amazon-bedrock/…`) is tolerated.
 */
export function bedrockInferenceProfileRank(id: string): 0 | 1 | 2 {
  const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  if (bare.startsWith('global.')) return 2;
  if (/^(us|eu|jp|apac|au|ca|sa|us-gov)\./.test(bare)) return 1;
  return 0;
}

// Newest first; on a release-date tie the Bedrock inference profile wins over
// the bare id (see bedrockInferenceProfileRank) — otherwise the FIRST listed
// id won, and models.dev lists the bare id first.
function newest(models: EnablementCandidate[]): EnablementCandidate {
  return models.reduce((best, model) => {
    const a = releasedAt(model) ?? 0;
    const b = releasedAt(best) ?? 0;
    if (a !== b) return a > b ? model : best;
    return bedrockInferenceProfileRank(model.id) > bedrockInferenceProfileRank(best.id)
      ? model
      : best;
  });
}

/**
 * The wire ids enabled by default: the newest model of each family, limited to
 * families with a release inside the window.
 *
 * A provider whose catalog carries no usable dates at all would otherwise
 * contribute NOTHING and vanish from the picker, so every provider always keeps
 * at least its newest model. That guarantee is why this returns a set per
 * provider rather than filtering the flat list by date.
 */
export function defaultEnabledModelIds(
  models: EnablementCandidate[],
  opts?: { now?: Date; windowMonths?: number },
): Set<string> {
  const now = (opts?.now ?? new Date()).getTime();
  const windowMs = (opts?.windowMonths ?? DEFAULT_ENABLEMENT_WINDOW_MONTHS) * MS_PER_MONTH;
  const enabled = new Set<string>();

  for (const [, providerModels] of groupBy(models, providerOf)) {
    const families = [...groupBy(providerModels, (m) => m.family || m.id).values()];
    const picks = families.map(newest);
    const current = picks.filter((m) => {
      const at = releasedAt(m);
      return at !== null && Math.abs(now - at) < windowMs;
    });
    // Never let a connected provider fall out of the picker entirely.
    for (const model of current.length > 0 ? current : [newest(picks)]) {
      enabled.add(model.id);
    }
  }

  return enabled;
}

/**
 * The candidates an AUTO-SELECTED default may be drawn from.
 *
 * `bedrockInferenceProfileRank` breaks a release-date TIE between a bare
 * Bedrock id and its `global.`/`us.` twin. That is not enough on its own:
 * models.dev does not publish which Bedrock families have an inference
 * profile, and the newest Bedrock model in the 2026-08-25 catalog —
 * `xai.grok-4.6` (2026-08-12) — ships with NO twin at all. It therefore won
 * "newest" outright and every fresh Bedrock-BYOK workspace auto-selected an
 * id Bedrock refuses ("Invocation of model ID xai.grok-4.6 with on-demand
 * throughput isn't supported. Retry your request with the ID or ARN of an
 * inference profile"), then looped "Retrying in Ns" forever. Proven live on
 * the Essentia self-host 2026-08-26.
 *
 * Rule: when a set carries ANY inference-profile id, its bare ids are not
 * auto-selectable. An inference profile is always invokable; a bare id may
 * not be, and nothing in the catalog says which. Bare ids stay LISTED and
 * pickable — a human can still choose one — but nothing chooses one FOR the
 * user. A set with no profile ids at all (every non-Bedrock provider) is
 * returned unchanged, so this is inert outside Bedrock.
 */
export function autoSeedableModels<T extends { id: string }>(models: T[]): T[] {
  if (!models.some((model) => bedrockInferenceProfileRank(model.id) > 0)) return models;
  return models.filter((model) => bedrockInferenceProfileRank(model.id) > 0);
}

/**
 * The model a surface should AUTO-SELECT for a provider when the user has
 * chosen nothing: the newest auto-selectable model (see `autoSeedableModels`),
 * with the Bedrock inference profile winning a release-date tie
 * (`global.` > regional > bare) and catalog order breaking a full tie.
 *
 * One implementation for both default paths — the gateway's `providerFlagship`
 * (apps/api) and the native pre-runtime picker's per-provider `default`
 * (packages/sdk) — because two copies of "which model do we pick for you" is
 * exactly how they drifted apart before.
 */
export function autoSeedDefaultModel<T extends { id: string; released?: string | null }>(
  models: T[],
): T | undefined {
  let best: T | undefined;
  for (const model of autoSeedableModels(models)) {
    if (!best) {
      best = model;
      continue;
    }
    const byDate = (model.released ?? '').localeCompare(best.released ?? '');
    if (byDate > 0) best = model;
    else if (
      byDate === 0 &&
      bedrockInferenceProfileRank(model.id) > bedrockInferenceProfileRank(best.id)
    ) {
      best = model;
    }
  }
  return best;
}
