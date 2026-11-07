/**
 * The command line of the test binaries (`ke2e`, `db-suites`, `latency-bench`):
 * `--name value`, `--name=value`, and a bare `--name` (true). A `--name`
 * followed by another `--flag`, an empty string, or nothing is bare. Every other
 * argument is positional, in order. A repeated flag keeps its last value.
 */
export function parseFlags(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  /** The value of `--name`: undefined when absent; throws when given without a value. */
  const value = (name: string) => {
    const v = flags[name];
    if (v === true) throw new Error(`--${name} requires a value`);
    return v;
  };
  return { positional, flags, value };
}
