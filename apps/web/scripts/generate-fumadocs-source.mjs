import { postInstall } from 'fumadocs-mdx/next';

// `.source/` (src/lib/source.ts, src/lib/use-cases-source.ts) is generated
// codegen and gitignored (apps/web/.gitignore) — it never travels with a
// commit, so a clean checkout starts with none at all.
//
// This script is chained into the `dev`, `dev:staging-env`, and `build` npm
// scripts (see apps/web/package.json), so it covers `pnpm dev`,
// `pnpm dev:staging-env`, and `pnpm build`. It does NOT cover Vercel:
// `vercel.json`'s `buildCommand` is the bare `"next build"`, which never
// invokes any npm script. Vercel relies entirely on `createMDX()` in
// next.config.ts for codegen — same as it always has for the sibling scripts
// chained into `dev`/`build` (validate-production-supabase-env.mjs,
// copy-viewer-wasm.mjs, copy-emojibase-data.mjs), none of which run on
// Vercel either.
//
// For the paths this script does cover, running codegen here — synchronously,
// before `next build`/`next dev` starts — beats relying on createMDX() alone:
// createMDX() regenerates `.source/` too, but only as an un-awaited side
// effect fired at config-load time (a race against Next's own module
// resolution), and its content-hash cache can skip rewriting a
// `.source/index.ts` left over from an older fumadocs-mdx major version if
// the underlying MDX source files didn't change (only the package did).
await postInstall();
console.log('[fumadocs-mdx] regenerated .source/');
