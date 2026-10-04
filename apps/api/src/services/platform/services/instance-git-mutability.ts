/**
 * May the UI change this instance's GitHub identity or git backend?
 *
 * On a cloud deployment both halves come from env variables, so the answer is
 * no and every mutation route answers `409 instance_identity_is_env_managed`.
 * That is the structural fix for the 2026-09-16 incident: the button that
 * shadowed production's App with a brand-new one stops existing wherever env
 * owns the configuration.
 *
 * A half that resolves to null is mutable: there is nothing to shadow.
 */

import { appIdentityEnvOwners, resolveAppIdentity } from './github-app-identity';
import { gitBackendEnvOwners, resolveGitBackend } from './managed-git-backend';

export const INSTANCE_IDENTITY_ENV_MANAGED = 'instance_identity_is_env_managed';

export interface InstanceGitMutability {
  mutable: boolean;
  /** The env variable names that own this instance. Empty when mutable. */
  envOwnedBy: string[];
}

export function resolveInstanceGitMutability(): InstanceGitMutability {
  const identity = resolveAppIdentity();
  const backend = resolveGitBackend();
  const envOwnedBy: string[] = [];
  if (identity?.source === 'env') envOwnedBy.push(...appIdentityEnvOwners());
  if (backend?.source === 'env') envOwnedBy.push(...gitBackendEnvOwners());
  return { mutable: envOwnedBy.length === 0, envOwnedBy };
}

/** The 409 body every mutation route returns when env owns this instance. */
export function envManagedConflictBody(envOwnedBy: string[]): {
  error: typeof INSTANCE_IDENTITY_ENV_MANAGED;
  message: string;
  env_owned_by: string[];
} {
  return {
    error: INSTANCE_IDENTITY_ENV_MANAGED,
    message:
      `This deployment's GitHub configuration is owned by its environment (${envOwnedBy.join(', ')}). ` +
      'Change those variables and redeploy; the UI must not shadow them.',
    env_owned_by: envOwnedBy,
  };
}
