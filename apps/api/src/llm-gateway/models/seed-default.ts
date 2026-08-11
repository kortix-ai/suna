import {
  getAccountModelDefaults,
  upsertAccountModelPreference,
} from '../../repositories/model-preferences';
import { invalidateAccountModelDefaults, isModelServableForAccount } from '../resolution/default-model';
import { toWireModel } from '../resolution/effective';
import { flagshipRefForEnvVar } from './picker-catalog';

// Auto-seed a sensible WORKSPACE default model the first time a workspace connects
// a model provider — so a brand-new workspace is not stuck on the bare platform
// default and "by default takes the workspace one" actually means something. Runs
// detached after a provider secret is saved; never throws into the request.
//
// Only seeds when the account has NO model default yet (account- or
// Workspace-scoped) and the chosen flagship is genuinely servable now that the key
// exists. Managed-only accounts need no seed — the platform flagship already
// applies. Idempotent: a concurrent connect or an already-set default is never
// clobbered (onlyIfAbsent → INSERT … ON CONFLICT DO NOTHING).

export async function seedWorkspaceDefaultModelOnConnect(params: {
  workspaceId: string;
  accountId: string;
  userId: string;
  secretName: string;
}): Promise<void> {
  try {
    const flagshipRef = flagshipRefForEnvVar(params.secretName);
    if (!flagshipRef) return; // not a known provider credential (e.g. codex auth)

    const defaults = await getAccountModelDefaults(params.accountId, params.workspaceId);
    if (defaults.account || defaults.workspaces[params.workspaceId]) return; // already chosen

    const servable = await isModelServableForAccount({
      userId: params.userId,
      accountId: params.accountId,
      workspaceId: params.workspaceId,
      freeModelsOnly: false, // a BYOK flagship resolves via the just-saved key for any tier
      model: flagshipRef,
    });
    if (!servable) return;

    await upsertAccountModelPreference({
      accountId: params.accountId,
      scope: 'project',
      scopeKey: params.workspaceId,
      model: toWireModel(flagshipRef),
      onlyIfAbsent: true,
    });
    invalidateAccountModelDefaults(params.accountId);
  } catch (err) {
    console.warn(
      `[seed-default] failed to seed workspace default for ${params.workspaceId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
