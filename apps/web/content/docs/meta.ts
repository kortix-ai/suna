import { defineMeta } from 'blume';

// The old meta.json also carried a "---Develop---" fumadocs separator and the
// external API-reference link ("[API reference](https://api.kortix.com/v1/docs)").
// Blume's meta.ts `pages` field is a plain string array (folderMetaSchema:
// pages: ZodArray<ZodString>) — no divider or link syntax, so both moved to
// blume.config.ts's `navigation` config; see that file for the decision.
//
// `blume.config.ts` imports this module and reads `pages` below to build its
// explicit sidebar tree (Blume's sidebar has no auto/explicit hybrid mode, so
// an explicit tree is mandatory here — see that file's comment). That means
// every one of the 12 ids below is mirrored into the built sidebar, not just
// the 2 that lack a direct meta.ts equivalent (the separator and the link).
// This file stays the source of truth for the order; blume.config.ts derives
// from it instead of retyping it.
export default defineMeta({
  title: 'Documentation',
  pages: [
    'index',
    'quickstart',
    'accounts',
    'credits',
    'project',
    'work',
    'connect',
    'feature-flags',
    'host',
    'cli',
    'sdk',
    'backend',
  ],
});
