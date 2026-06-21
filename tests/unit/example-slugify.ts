export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isReservedSlug(slug: string, reserved: ReadonlySet<string>): boolean {
  return reserved.has(slug);
}
