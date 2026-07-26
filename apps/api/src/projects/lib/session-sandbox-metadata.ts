/** Read the server-owned resolved template from durable session metadata. */
export function sandboxSlugFromSessionMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).sandbox_slug;
  if (typeof value !== 'string') return undefined;
  const slug = value.trim();
  return /^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug) ? slug : undefined;
}

/** Apply the session sandbox precedence contract. */
export function resolveSessionSandboxSlug(input: {
  explicit?: string | null;
  agent?: string | null;
  project?: string | null;
}): string {
  return input.explicit ?? input.agent ?? input.project ?? 'default';
}
