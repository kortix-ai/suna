import {
  deleteProjectSecret,
  getProjectSecretEnv,
  listProjectSecrets,
  upsertProjectSecret,
} from "./db";
import type { EnvRequirementStatus, EnvRequirements, ProjectSecretsStatus, SecretMetadata } from "./types";

export function listSecrets(projectId: string): SecretMetadata[] {
  return listProjectSecrets(projectId);
}

export function saveSecret(input: { projectId: string; key: string; value: string }): SecretMetadata {
  return upsertProjectSecret(input);
}

export function removeSecret(projectId: string, key: string): boolean {
  return deleteProjectSecret(projectId, key);
}

export function sandboxEnvForProject(projectId: string): Record<string, string> {
  return getProjectSecretEnv(projectId);
}

export function projectSecretStatus(projectId: string, requirements: EnvRequirements): ProjectSecretsStatus {
  const secrets = listProjectSecrets(projectId);
  const byKey = new Map(secrets.map((secret) => [secret.key, secret]));
  const requiredSet = new Set(requirements.required);
  const optionalSet = new Set(requirements.optional);

  const statusFor = (key: string, required: boolean): EnvRequirementStatus => {
    const secret = byKey.get(key);
    return {
      key,
      required,
      set: Boolean(secret),
      updatedAt: secret?.updatedAt || null,
    };
  };

  const required = requirements.required.map((key) => statusFor(key, true));
  const optional = requirements.optional
    .filter((key) => !requiredSet.has(key))
    .map((key) => statusFor(key, false));
  const undeclared = secrets
    .filter((secret) => !requiredSet.has(secret.key) && !optionalSet.has(secret.key))
    .map((secret) => ({
      key: secret.key,
      required: false,
      set: true,
      updatedAt: secret.updatedAt,
    }));

  return {
    required,
    optional,
    undeclared,
    missingRequired: required.filter((entry) => !entry.set).map((entry) => entry.key),
  };
}
