// Pure CLI-parity logic — no file IO, no Bun/import.meta references, so it
// imports cleanly under both bun (the ke2e runner) and node/vitest (unit tests).
// The file-reading wrapper lives in check-cli-parity.ts.

export interface Route {
  method: string;
  path: string;
}

export interface CliParityResult {
  total: number;
  mapped: number;
  exempt: number;
  unmapped: string[];
  newUnmapped: string[];
  resolvedSinceBaseline: string[];
  pass: boolean;
}

/** Collapse path params (`:id`, `:projectId`, …) to `:*` so a route matches
 *  regardless of the param name — same normalization as check-coverage.ts. */
export function normalize(method: string, path: string): string {
  const segs = path.split("/").map((s) => (s.startsWith(":") ? ":*" : s));
  return `${method.toUpperCase()} ${segs.join("/")}`;
}

export function computeCliParity(input: {
  routes: Route[];
  mapped: Array<{ method: string; path: string }>;
  exempt: Array<{ method: string; path: string }>;
  baselineUnmapped: string[];
  updateBaseline?: boolean;
}): CliParityResult {
  const manifestKeys = input.routes.map((r) => normalize(r.method, r.path));
  const mappedSet = new Set(input.mapped.map((e) => normalize(e.method, e.path)));
  const exemptSet = new Set(input.exempt.map((e) => normalize(e.method, e.path)));

  const unmapped = manifestKeys
    .filter((k) => !mappedSet.has(k) && !exemptSet.has(k))
    .sort();

  const base = new Set(input.baselineUnmapped);
  const newUnmapped = unmapped.filter((k) => !base.has(k));
  const resolvedSinceBaseline = [...base].filter((k) => !unmapped.includes(k)).sort();

  const pass = Boolean(input.updateBaseline) || newUnmapped.length === 0;

  return {
    total: manifestKeys.length,
    mapped: mappedSet.size,
    exempt: exemptSet.size,
    unmapped,
    newUnmapped,
    resolvedSinceBaseline,
    pass,
  };
}
