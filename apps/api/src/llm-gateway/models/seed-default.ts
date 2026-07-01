import type { Effect } from 'effect';
import {
  getAccountModelDefaults,
  upsertAccountModelPreference,
} from '../../repositories/model-preferences';
import { invalidateAccountModelDefaults, isModelServableForAccount } from '../resolution/default-model';
import { toWireModel } from '../resolution/effective';
import { flagshipRefForEnvVar } from './picker-catalog';

// Auto-seed a sensible PROJECT default model the first time a workspace connects
// a model provider — so a brand-new project isn't stuck on the bare platform
// default and "by default takes the project one" actually means something. Runs
// detached after a provider secret is saved; never throws into the request.
//
// Only seeds when the account has NO model default yet (account- or
// project-scoped) and the chosen flagship is genuinely servable now that the key
// exists. Managed-only accounts need no seed — the platform flagship already
// applies. Idempotent: a concurrent connect or an already-set default is never
// clobbered (onlyIfAbsent → INSERT … ON CONFLICT DO NOTHING).

export async function seedProjectDefaultModelOnConnect(params: {
  projectId: string;
  accountId: string;
  userId: string;
  secretName: string;
}): Promise<void> {
  try {
    const flagshipRef = flagshipRefForEnvVar(params.secretName);
    if (!flagshipRef) return; // not a known provider credential (e.g. codex auth)

    const defaults = await getAccountModelDefaults(params.accountId);
    if (defaults.account || defaults.projects[params.projectId]) return; // already chosen

    const servable = await isModelServableForAccount({
      userId: params.userId,
      accountId: params.accountId,
      projectId: params.projectId,
      freeModelsOnly: false, // a BYOK flagship resolves via the just-saved key for any tier
      model: flagshipRef,
    });
    if (!servable) return;

    await upsertAccountModelPreference({
      accountId: params.accountId,
      scope: 'project',
      scopeKey: params.projectId,
      model: toWireModel(flagshipRef),
      onlyIfAbsent: true,
    });
    invalidateAccountModelDefaults(params.accountId);
  } catch (err) {
    console.warn(
      `[seed-default] failed to seed project default for ${params.projectId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
