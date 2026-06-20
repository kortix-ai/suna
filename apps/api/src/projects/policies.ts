/**
 * Project-level `[[policies]]` + `[policy]` parsing for kortix.toml.
 *
 * Project policies span EVERY connector in the project — patterns are
 * fully-qualified (`<connector-slug>.<path>` or globs over that), and they're
 * evaluated before any connector-scoped rule (docs/specs/executor.md §8).
 * `[policy].default_mode` controls the fallback when no rule matches:
 *   • `risk` — read = always_run, write/destructive = require_approval
 *   • `allow_all` — every tool runs (legacy default for back-compat)
 *
 * Mirror the connectors / triggers / apps parser shape: never throws on a bad
 * entry, collects them in `errors` so the UI can render them next to the good
 * ones. Defaults are permissive (no policies + allow_all) so existing projects
 * without a `[policy]` block keep current behavior.
 */
import { MANIFEST_FILENAME, type ParsedManifest } from './triggers';

type ProjectPolicyAction = 'always_run' | 'require_approval' | 'block';
const POLICY_ACTIONS: readonly ProjectPolicyAction[] = ['always_run', 'require_approval', 'block'];

export type DefaultMode = 'risk' | 'allow_all';
const DEFAULT_MODES: readonly DefaultMode[] = ['risk', 'allow_all'];

export interface ProjectPolicySpec {
  /** Glob over fully-qualified tool paths: `*`, `stripe.*`, `*.delete*`, `stripe.charges.create`. */
  match: string;
  action: ProjectPolicyAction;
}

export interface ProjectPolicySettings {
  /** Falls back to `allow_all` for missing `[policy]` blocks (back-compat). */
  defaultMode: DefaultMode;
}

interface ProjectPolicyParseError {
  path: string;
  error: string;
}

export interface LoadedProjectPolicies {
  policies: ProjectPolicySpec[];
  settings: ProjectPolicySettings;
  errors: ProjectPolicyParseError[];
}

const DEFAULT_SETTINGS: ProjectPolicySettings = { defaultMode: 'allow_all' };

/**
 * Extract `[[policies]]` + `[policy]` from a parsed manifest. Never throws.
 */
export function extractProjectPolicies(manifest: ParsedManifest): LoadedProjectPolicies {
  const errors: ProjectPolicyParseError[] = [];

  // ── [policy] block (default_mode) ──────────────────────────────────────────
  let settings: ProjectPolicySettings = { ...DEFAULT_SETTINGS };
  const policyBlock = manifest.raw.policy;
  if (policyBlock !== undefined && policyBlock !== null) {
    if (typeof policyBlock !== 'object' || Array.isArray(policyBlock)) {
      errors.push({ path: `${MANIFEST_FILENAME}#policy`, error: '[policy] must be a table' });
    } else {
      const row = policyBlock as Record<string, unknown>;
      if (row.default_mode !== undefined) {
        const mode = typeof row.default_mode === 'string' ? row.default_mode.trim().toLowerCase() : '';
        if (!DEFAULT_MODES.includes(mode as DefaultMode)) {
          errors.push({
            path: `${MANIFEST_FILENAME}#policy.default_mode`,
            error: `[policy].default_mode must be one of ${DEFAULT_MODES.join(', ')} (got "${mode || 'unset'}")`,
          });
        } else {
          settings = { defaultMode: mode as DefaultMode };
        }
      }
    }
  }

  // ── [[policies]] array ─────────────────────────────────────────────────────
  const policies: ProjectPolicySpec[] = [];
  const raw = manifest.raw.policies;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) {
      errors.push({
        path: MANIFEST_FILENAME,
        error: '`policies` must be an array of tables — use [[policies]], not [policies]',
      });
    } else {
      raw.forEach((entry, i) => {
        const path = `${MANIFEST_FILENAME}#policies[${i}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push({ path, error: `[[policies]] entry #${i + 1} is not a table` });
          return;
        }
        const row = entry as Record<string, unknown>;
        const match = typeof row.match === 'string' && row.match.trim() ? row.match.trim() : '';
        if (!match) {
          errors.push({ path, error: `[[policies]] entry #${i + 1} is missing \`match\`` });
          return;
        }
        const action = typeof row.action === 'string' ? row.action.trim().toLowerCase() : '';
        if (!POLICY_ACTIONS.includes(action as ProjectPolicyAction)) {
          errors.push({
            path,
            error: `[[policies]] entry #${i + 1} \`action\` must be one of ${POLICY_ACTIONS.join(', ')} (got "${action || 'unset'}")`,
          });
          return;
        }
        policies.push({ match, action: action as ProjectPolicyAction });
      });
    }
  }

  return { policies, settings, errors };
}

/**
 * Convert a list of project policies back to the TOML-shaped entries that live
 * in `manifest.raw.policies`. Inverse of `extractProjectPolicies`. Used by the
 * admin CRUD path to round-trip a dashboard edit before committing.
 */
export function projectPoliciesToTomlEntries(policies: ProjectPolicySpec[]): Array<Record<string, unknown>> {
  return policies.map((p) => ({ match: p.match, action: p.action }));
}

/** Serialize `[policy]` settings — null when default (so we don't write empty blocks). */
export function projectPolicySettingsToToml(settings: ProjectPolicySettings): Record<string, unknown> | null {
  if (settings.defaultMode === DEFAULT_SETTINGS.defaultMode) return null;
  return { default_mode: settings.defaultMode };
}
