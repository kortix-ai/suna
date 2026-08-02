import { copyEmojibaseData } from './emojibase-data.mjs';

// Thin CLI entry point — the actual copy logic (and the "why") lives in
// scripts/emojibase-data.mjs, which next.config.ts also imports directly so
// there is exactly one source of truth for the asset list and copy behavior.
for (const asset of copyEmojibaseData()) {
  console.log(`Copied ${asset.from.split('/').slice(-2).join('/')} -> ${asset.out}`);
}
