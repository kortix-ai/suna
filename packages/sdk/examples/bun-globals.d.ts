/**
 * Minimal ambient shim for the one `Bun` global 03-server-wrapper.ts needs
 * (`Bun.serve`). Deliberately NOT a `@types/bun` devDependency on the package:
 * `packages/sdk/tsconfig.json` doesn't restrict `compilerOptions.types`, so
 * adding an ambient `@types/*` package here would also auto-leak into the
 * package's own `tsc --noEmit` run (its globals overlap/redeclare DOM
 * `fetch`/`Response`/`WebSocket`, which the SDK's own isomorphic code relies
 * on meaning the browser/DOM shape). Picked up automatically by
 * `examples/tsconfig.json`'s `"include": ["*.ts"]` (a `.d.ts` file matches that
 * glob). A real Bun project should just depend on `@types/bun` directly
 * instead of copying this.
 */
declare const Bun: {
  serve(options: {
    port?: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }): { stop: () => void };
};
