import {
  createModelFallbackPolicyEngine,
  type AuthedPrincipal,
  type ModelFallbackPolicy,
  type ModelGenerationDefaults,
  type ModelRouteInput,
  type ModelRoutePlan,
} from '@kortix/llm-gateway';
import { type CatalogModel, clampGenerationConfig } from '@kortix/llm-catalog';
import type { ProjectModelGenerationConfig, ProjectRoutingFallback, ProjectRoutingRule } from './project-policy';

export interface ResolvedProjectRoutingPolicy {
  visionModel: string | null;
  defaultFallback: ProjectRoutingFallback | null;
  rules: ProjectRoutingRule[];
  modelGenerationConfig?: ProjectModelGenerationConfig;
}

export interface GatewayRouteResolverOptions {
  /** A function when the value can change while the process runs (the managed lineup refreshes). */
  defaultModel: string | (() => string);
  /** Reroute target for image-bearing default requests; empty/undefined = no reroute. */
  visionModel: string | undefined | (() => string | undefined);
  /** Read per request: the managed fallbacks follow the live lineup. */
  policies: readonly ModelFallbackPolicy[] | (() => readonly ModelFallbackPolicy[]);
  supportsImage: (model: string) => boolean;
  getProjectPolicy?: (projectId: string) => Promise<ResolvedProjectRoutingPolicy | null>;
  /**
   * The principal's account/project/agent default, for a principal that did
   * not carry one (gateway admission leaves it unresolved). Called only when
   * the route depends on it: an image request or a project default fallback.
   */
  resolveDefaultModel?: (principal: AuthedPrincipal) => Promise<string | undefined>;
  /**
   * Resolve `model`'s live catalog capability record (reasoning_options,
   * temperature, limit.output, ...) — used ONLY to clamp a project's
   * configured generation defaults before they're injected into a request
   * (see `generationDefaultsFor` below). Defaults to
   * `catalogModelForWireModel` (apps/api's models/catalog-models.ts);
   * overridable so tests don't need a live runtime catalog.
   */
  catalogModelFor?: (model: string) => CatalogModel | undefined;
  /**
   * The canonical id a platform policy is keyed by. A legacy or `kortix/`-prefixed
   * id (`kimi-k3`, `kortix/deepseek-v4.1-flash`) resolves to the same upstream as
   * its canonical id and must get the same fallback chain.
   */
  canonicalModel?: (model: string) => string;
  /**
   * The route of an `/images/*` request (`requires.imageOutput`). Image
   * requests never take the chat policies above; chat requests never call this.
   */
  imageRoute?: (principal: AuthedPrincipal, requestedModel: string) => Promise<ModelRoutePlan>;
}

export type GatewayRouteResolver = (
  principal: AuthedPrincipal,
  input: ModelRouteInput,
) => Promise<ModelRoutePlan>;

// Re-clamped here (NOT just trusted from what was clamped at write time) —
// the live catalog can change between when a project configured a generation
// default and when a request actually resolves it (a model losing
// reasoning_options, a provider changing its temperature support, ...). This
// is the last, authoritative gate before a value reaches the wire.
function generationDefaultsFor(
  model: string,
  config: ProjectModelGenerationConfig | undefined,
  catalogModelFor: (model: string) => CatalogModel | undefined,
): ModelGenerationDefaults | undefined {
  const entry = config?.[model];
  if (!entry) return undefined;
  const clamped = clampGenerationConfig(entry, catalogModelFor(model));
  return Object.keys(clamped).length ? clamped : undefined;
}

/**
 * Build the API/control-plane route resolver. The policy engine is generic;
 * this host-owned layer supplies the actual model ids and account defaults.
 */
const valueOf = <T,>(v: T | (() => T)): T => (typeof v === 'function' ? (v as () => T)() : v);

export function createGatewayRouteResolver(
  options: GatewayRouteResolverOptions,
): GatewayRouteResolver {
  const catalogModelFor = options.catalogModelFor ?? (() => undefined);

  return async (principal, input) => {
    if (input.requires.imageOutput && options.imageRoute) return options.imageRoute(principal, input.requestedModel);
    const fallbackPolicies = createModelFallbackPolicyEngine(valueOf(options.policies));
    const projectPolicy = principal.projectId && options.getProjectPolicy
      ? await options.getProjectPolicy(principal.projectId)
      : null;
    // The default decides only an image reroute (the project chain covers
    // every model); a text request never reads it.
    const defaultMatters = input.requires.imageInput;
    const principalDefault = principal.defaultModel
      ?? (defaultMatters && options.resolveDefaultModel
        ? await options.resolveDefaultModel(principal).catch(() => undefined)
        : undefined);
    const concreteDefault = principalDefault || valueOf(options.defaultModel);
    const isDefaultRequest = input.requestedModel === concreteDefault;
    let primaryModel = input.requestedModel;

    if (isDefaultRequest && input.requires.imageInput && !options.supportsImage(primaryModel)) {
      // No configured vision target (the managed lineup has no vision model
      // since the 2026-08-10 slim-down) → keep the default model rather than
      // rerouting to a dead ref that resolves as model_not_found.
      const visionTarget = projectPolicy?.visionModel || valueOf(options.visionModel);
      if (visionTarget) primaryModel = visionTarget;
    }

    // Bound once per request (not per candidate) — cheap (a config lookup +
    // a catalog map lookup), and gives every candidate in the failover loop
    // its OWN freshly-clamped defaults instead of trusting the primary
    // model's. See `ModelRoutePlan.generationDefaultsForModel`'s doc comment.
    const generationDefaultsForModel = (model: string): ModelGenerationDefaults | undefined =>
      generationDefaultsFor(model, projectPolicy?.modelGenerationConfig, catalogModelFor);
    const generationDefaults = generationDefaultsForModel(primaryModel);

    const exactRule = projectPolicy?.rules.find((rule) => rule.model === primaryModel);
    if (exactRule) {
      return {
        policyId: `project:exact:${primaryModel}`,
        primaryModel,
        fallbackModels: exactRule.fallbackModels,
        fallbackOn: exactRule.fallbackOn,
        generationDefaults,
        generationDefaultsForModel,
      };
    }

    // The project's chain is a catch-all: it covers every model that has no
    // exact rule. It never depends on `isDefaultRequest`, because the
    // principal's default is one model. An agent with its own default, or a
    // default with every account paused, would otherwise take a request for
    // the project's own model out of the chain.
    if (projectPolicy?.defaultFallback) {
      return {
        policyId: 'project:default',
        primaryModel,
        fallbackModels: projectPolicy.defaultFallback.models,
        fallbackOn: projectPolicy.defaultFallback.fallbackOn,
        generationDefaults,
        generationDefaultsForModel,
      };
    }

    const policy = fallbackPolicies.route(options.canonicalModel?.(primaryModel) ?? primaryModel);
    if (!policy) {
      return {
        policyId: 'direct',
        primaryModel,
        fallbackModels: [],
        fallbackOn: 'transient',
        generationDefaults,
        generationDefaultsForModel,
      };
    }

    return {
      policyId: policy.policyId,
      primaryModel,
      fallbackModels: policy.fallbackModels,
      fallbackOn: policy.fallbackOn,
      generationDefaults,
      generationDefaultsForModel,
    };
  };
}
