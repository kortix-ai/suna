export const KORTIX_ENV_JSON = "KORTIX_ENV_JSON";

/**
 * Expand the aggregate ECS environment secret before application config reads
 * process.env. Explicit task-definition values win over values in the blob.
 */
export function hydrateEnvironmentSecret(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment[KORTIX_ENV_JSON];
  if (raw === undefined) return 0;
  delete environment[KORTIX_ENV_JSON];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${KORTIX_ENV_JSON} must contain a JSON object`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${KORTIX_ENV_JSON} must contain a JSON object`);
  }

  let hydrated = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${KORTIX_ENV_JSON} key "${key}" must be a string`);
    }
    if (environment[key] === undefined) {
      environment[key] = value;
      hydrated += 1;
    }
  }
  return hydrated;
}
