import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = ['src/features/session'];
const ALLOW: Record<string, RegExp[]> = {
  // Restored byte-identical from origin/main (2026-07-21 selector restoration)
  // — keep main's 13px label rather than mutate the verbatim file.
  'auto-model-toggle.tsx': [/text-\[13px\]/, /rounded-xl/],
  'acp-chat-item-row.tsx': [/rounded-3xl/], // user bubble — deliberate chat idiom
  'session-chat-input.tsx': [/rounded-\[24px\]/], // composer card — deliberate
  // instant-session-shell.tsx pre-submit hero composer intentionally overrides
  // the composer's radius to `rounded-xl` to pixel-match project-home.tsx's
  // hero card (also out of this sweep's bounded scope) so the shell → chat
  // crossfade doesn't visibly "pop" the composer's corners. And its optimistic
  // turn bubble intentionally duplicates acp-chat-item-row.tsx's `rounded-3xl`
  // user bubble byte-for-byte so the bubble never shifts across the same
  // crossfade. Both are load-bearing for the documented anti-pop animation,
  // not decorative slop — see the comments at their call sites.
  'instant-session-shell.tsx': [/rounded-xl/, /rounded-3xl/],
};
const BANNED: Array<[name: string, re: RegExp]> = [
  ['raw amber palette', /\bamber-\d{2,3}\b/],
  ['raw hex background', /bg-\[#[0-9a-fA-F]{3,8}\]/],
  ['off-scale radius', /rounded-(xl|2xl|3xl)\b/],
  ['raw emerald palette', /\bemerald-\d{2,3}\b/],
  ['transition: all', /transition-all/],
];
describe('ACP surface design guard', () => {
  for (const dir of DIRS)
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
      it(`${dir}/${f} uses tokens + radius scale`, () => {
        const src = readFileSync(join(dir, f), 'utf8');
        for (const [name, re] of BANNED) {
          // Per-occurrence allow check (not a whole-category skip): a file's
          // ALLOW entries only exempt the literal substrings they match
          // (e.g. `rounded-3xl` on the user bubble), so any OTHER offender
          // in the same banned category still fails. A plain `.source`
          // equality check between a narrow allow pattern and the broader
          // banned pattern can never be true, which would make the two
          // blessed exceptions unrepresentable — so this walks every match
          // of `re` and checks it against the file's allow list instead.
          const matches = src.match(new RegExp(re.source, 'g')) ?? [];
          const unallowed = matches.filter(
            (m) => !(ALLOW[f] ?? []).some((a) => a.test(m)),
          );
          expect(unallowed, `${name} in ${f}`).toEqual([]);
        }
      });
    }
});
