import { config } from '../config';
import { gatewayModelCatalog } from '../llm-gateway/models/catalog-models';
import { servableProjectCatalog } from '../llm-gateway/models/servable-catalog';
import { platformDefaultModelId } from '../llm-gateway/models/served-managed-models';
import { projectLlmGatewayEnabledById } from '../llm-gateway/enablement';
import { isModelServableForAccount } from '../llm-gateway/resolution/default-model';
import { accountMayUseManagedModels } from '../billing/services/entitlements';

/**
 * A chat message that carries an image is unanswerable on a text-only model.
 *
 * OpenCode decides whether to send an image upstream from the capabilities it
 * was given for the model. When they say no image, the agent downloads the
 * file, calls `read`, gets "Image read successfully", and still has nothing to
 * look at — then hunts for ImageMagick / tesseract / an OCR API and the turn
 * dies with no answer. Observed live on Teams 2026-09-19 (session
 * 196a99f5-8d4d-4d48-988e-cec7152e0d10, `deepseek-v4-flash`).
 *
 * `LLM_GATEWAY_VISION_MODEL` already encodes the platform's answer for this —
 * "route image-bearing DEFAULT-model requests to this model" — but the gateway
 * rule (llm-gateway/routing/resolve-route.ts) can only fire when an image part
 * reaches the gateway, and OpenCode strips it before that, precisely because
 * the model declares it cannot take one. So a channel that KNOWS the inbound
 * message has an image must pick the model itself, up front.
 *
 * Two live findings shape how the pick is made, both from dev on 2026-09-21:
 *
 * 1. **`attachment` is not the vision flag.** `glm-5.3-flash` is
 *    `attachment: true` and `input.image: false` — the managed catalog marks
 *    it `vision: true` by hand while its models.dev record carries text-only
 *    modalities, and OpenCode honours the modalities. Routing an image turn to
 *    it produced *"the model I'm running on right now can't process images"*.
 *    So the predicate is `modalities.input` containing `image`.
 * 2. **A configured target is not necessarily servable.** `gpt-5.6-luna`
 *    answers `requires Kortix's managed provider, which is disabled on this
 *    deployment`, and pinning a prompt to it turns a degraded answer into a
 *    failed turn. Candidates therefore come from `servableProjectCatalog` —
 *    the same list the sandbox registers and the picker shows — and each is
 *    still confirmed with `isModelServableForAccount`.
 *
 * When nothing qualifies the answer is `null` and the turn runs unchanged.
 */

/** How many candidates to probe. A probe is a candidate resolution, not an upstream request. */
const MAX_CANDIDATE_PROBES = 8;

type CapabilityView = { attachment?: boolean; modalities?: { input?: string[] }; cost?: { input?: number } };

function wireModelId(model: string): string {
  return model.startsWith('kortix/') ? model.slice('kortix/'.length) : model;
}

/**
 * Can this model actually take an image?
 *
 * `modalities.input` is authoritative because it is what OpenCode honours.
 * `attachment` is only consulted when no modalities are published at all,
 * where it is the sole signal available — never as an override of them.
 */
export function capabilityReadsImages(model: CapabilityView | undefined): boolean {
  if (!model) return false;
  const inputs = model.modalities?.input;
  if (Array.isArray(inputs) && inputs.length > 0) return inputs.includes('image');
  return model.attachment === true;
}

/** The cheap, synchronous check used on the channel hot path. */
export function modelReadsImages(projectId: string, model: string | null | undefined): boolean {
  if (!model) return false;
  return capabilityReadsImages(gatewayModelCatalog(projectId)[wireModelId(model)]);
}

function inputCostOf(cost: { input?: number } | undefined): number {
  return typeof cost?.input === 'number' ? cost.input : Number.POSITIVE_INFINITY;
}

/**
 * Replacement candidates, drawn from what this project can actually run.
 *
 * Ordered: the operator's configured vision target, then the platform default,
 * then everything else cheapest-first. Models the project has disabled are
 * skipped, as is the model we are trying to move off.
 */
async function replacementCandidates(input: {
  projectId: string;
  accountId: string;
  principalUserId: string;
  currentModel: string | null;
  needsVision: boolean;
}): Promise<string[]> {
  const { projectId, accountId, principalUserId, currentModel, needsVision } = input;
  const catalog = await servableProjectCatalog({ projectId, accountId, principalUserId }).catch(
    () => null,
  );
  if (!catalog) return [];

  const usable = Object.entries(catalog.models).filter(
    ([, m]) => m.enabled !== false && (!needsVision || capabilityReadsImages(m)),
  );
  const preferred = [
    ...(needsVision ? [config.LLM_GATEWAY_VISION_MODEL?.trim()] : []),
    catalog.defaultModel,
    platformDefaultModelId(),
  ].filter((m): m is string => !!m);
  const byCost = usable
    .sort(([, a], [, b]) => inputCostOf(a.cost) - inputCostOf(b.cost))
    .map(([id]) => id);

  const usableIds = new Set(usable.map(([id]) => id));
  const current = currentModel ? wireModelId(currentModel) : null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [...preferred, ...byCost]) {
    const wire = wireModelId(candidate);
    if (wire === current || seen.has(wire) || !usableIds.has(wire)) continue;
    seen.add(wire);
    out.push(wire);
    if (out.length >= MAX_CANDIDATE_PROBES) break;
  }
  return out;
}

/**
 * The model this channel turn must run on, or `null` to leave it alone.
 *
 * Two things make a turn unanswerable before it starts, and both are
 * invisible to the person typing in Teams or Slack:
 *
 * 1. The message carries an image the pinned model cannot read (`hasImage`).
 * 2. The pinned model is no longer servable at all. Models are retired from
 *    the catalog and nothing re-validates a session's pin — the dev Teams
 *    session was pinned to `deepseek-v4-flash` and
 *    `PUT /sessions/:id/model` answered
 *    `Model "deepseek-v4-flash" is not available for this account`, so every
 *    turn would have failed upstream with no way for the user to know why.
 */
export async function channelTurnModel(input: {
  projectId: string;
  accountId: string;
  userId: string | null | undefined;
  currentModel: string | null | undefined;
  hasImage: boolean;
}): Promise<string | null> {
  const { projectId, accountId, userId, currentModel, hasImage } = input;
  if (!userId) return null;

  // EVERY inbound channel message lands here, so the ordinary case — a plain
  // text message on a healthy pin — must cost no I/O at all. The catalog is an
  // in-memory snapshot; both questions below are answered from it, and nothing
  // else runs unless one of them says something is wrong.
  const catalog = gatewayModelCatalog(projectId);
  const effective = currentModel || platformDefaultModelId();
  const needsVision = hasImage && !modelReadsImages(projectId, effective);
  // A pin the catalog no longer carries is the cheap signal for "retired".
  const pinMissing = !!currentModel && !catalog[wireModelId(currentModel)];
  if (!needsVision && !pinMissing) return null;

  if (!(await projectLlmGatewayEnabledById(projectId).catch(() => false))) return null;

  const freeModelsOnly = !(await accountMayUseManagedModels(accountId).catch(() => false));
  const probe = (model: string) =>
    isModelServableForAccount({ userId, accountId, projectId, freeModelsOnly, model }).catch(
      () => false,
    );

  // Confirm the retirement authoritatively before replacing anything: a BYOK
  // ref can be absent from this view for reasons that are not a retirement.
  const pinUnservable = pinMissing && currentModel ? !(await probe(wireModelId(currentModel))) : false;
  if (!needsVision && !pinUnservable) return null;

  const candidates = await replacementCandidates({
    projectId,
    accountId,
    principalUserId: userId,
    currentModel: effective,
    needsVision,
  });
  for (const model of candidates) {
    if (await probe(model)) {
      console.info("[channels] replacing this turn's model", {
        projectId,
        from: currentModel ?? null,
        to: model,
        reason: needsVision ? (pinUnservable ? 'image+retired' : 'image') : 'retired',
      });
      return model;
    }
  }
  console.info('[channels] no servable replacement model — the turn runs unchanged', {
    projectId,
    needsVision,
    pinUnservable,
    tried: candidates,
  });
  return null;
}

/**
 * `{ providerID, modelID }` for a prompt-level model override.
 *
 * The provider is ALWAYS `kortix`. Every served model — managed, BYOK and
 * `codex/*` alike — is registered under the one synthetic `kortix` OpenCode
 * provider (see `buildKortixProvider` in the sandbox agent server, and the
 * `provider` field note in llm-gateway/models/catalog-models.ts), so the id
 * keeps its own slashes: `codex/gpt-6-astra` is a MODEL on `kortix`, not a
 * model `gpt-6-astra` on a provider `codex`. Splitting on the slash addresses
 * a provider the runtime does not have, and the override is silently dropped —
 * which would break exactly the codex models that can read images.
 *
 * Verified live on dev 2026-09-21: `{providerID:'kortix', modelID:'glm-5.3-flash'}`
 * ran the turn on `glm-5.3-flash`, and `PUT /sessions/:id/model` echoes
 * `kortix/codex/gpt-6-astra` for the codex ids.
 */
export function promptModelOverride(model: string): { providerID: string; modelID: string } {
  return { providerID: 'kortix', modelID: wireModelId(model) };
}
