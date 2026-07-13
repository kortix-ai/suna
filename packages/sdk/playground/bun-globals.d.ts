/**
 * Minimal ambient shim for the one `Bun` global run-all.ts needs
 * (`Bun.spawn`). Same rationale as examples/bun-globals.d.ts: deliberately
 * NOT a `@types/bun` devDependency (its globals would leak into the package's
 * own isomorphic `tsc --noEmit` run). Picked up automatically by
 * playground/tsconfig.json's include glob (a `.d.ts` file matches it).
 */
declare const Bun: {
  spawn(
    cmd: string[],
    options?: {
      env?: Record<string, string | undefined>;
      stdout?: "inherit" | "pipe" | "ignore";
      stderr?: "inherit" | "pipe" | "ignore";
    },
  ): { exited: Promise<number> };
};
