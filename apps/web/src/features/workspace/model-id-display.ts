/**
 * Whether a model's raw ID is worth showing next to its display name.
 *
 * The model list used to print the ID under every name unconditionally, and
 * for most of the catalog that is the name again in kebab-case — `DeepSeek V4
 * Flash` over `deepseek-v4-flash`. That doubled the height of every row with a
 * second line that answers no question, in a palette whose whole job is
 * scanning names.
 *
 * The ID stays wherever it actually disambiguates: a dated snapshot behind a
 * rolling alias (`GPT-5` / `gpt-5-2025-01-01`), a vendor string that shares no
 * stem with the marketing name (`Kimi K2` / `moonshotai/kimi-k2-instruct`).
 *
 * The provider path prefix is ignored on purpose — the provider is already the
 * group heading directly above the row.
 */
export function slugifyModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function modelIdAddsInformation(modelName: string, modelID: string): boolean {
  if (!modelID) return false;
  if (!modelName) return true;
  const slug = slugifyModelName(modelName);
  if (!slug) return true;
  const id = modelID.toLowerCase();
  const tail = id.split('/').pop() ?? id;
  return slug !== id && slug !== tail;
}
