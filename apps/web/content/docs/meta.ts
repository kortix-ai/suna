import { defineMeta } from 'blume';

// The old meta.json also carried a "---Develop---" fumadocs separator and the
// external API-reference link ("[API reference](https://api.kortix.com/v1/docs)").
// Blume's meta.ts `pages` field is a plain string array (folderMetaSchema:
// pages: ZodArray<ZodString>) — no divider or link syntax. Both moved to
// blume.config.ts's `navigation` config; see that file for the decision.
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
