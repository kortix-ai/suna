/**
 * skill-mentions — pure trigger detection, filtering, insertion, and
 * submission-resolution logic behind the composer's `#` skill picker
 * (COR-160 remaining part: the Skills page was removed from mobile, so a
 * skill must stay reachable from the composer).
 *
 * No new wire format is invented here. `apps/web`'s `/` menu already groups
 * `Command.source === 'skill'` under a "Skills" heading
 * (`apps/web/src/features/session/composer/menus/slash-items.ts`
 * `bucketFor`), and at submit time `planDraftSubmission`
 * (`apps/web/src/features/session/composer/composer-logic.ts`) resolves the
 * picked command's NAME against the LIVE command list:
 *   - found  -> `{ kind: 'command', command, args }`, dispatched as a
 *     structured call (web: `session.runCommand`; mobile:
 *     `SessionChatInput`'s `onCommand` prop -> `SessionPage.tsx`'s
 *     `handleCommand` -> `POST ${sandboxUrl}/session/${sessionId}/command`
 *     with `{ command: cmd.name, arguments: args }` — the SAME endpoint
 *     `session.runCommand` posts to).
 *   - not found (a skill deleted after it was picked) -> re-inlined as
 *     plain text `/<name> <args>` and sent as an ordinary message.
 *
 * Mobile's `#` trigger reuses the SAME `Command[]` `/` already fetches
 * (`useOpenCodeCommands`, passed into `SessionChatInput` as `commands`),
 * filtered to `source === 'skill'` — the identical "Skills" bucket web's `/`
 * menu shows. `resolveSkillSubmission` below is `planDraftSubmission`'s
 * mirror for a token that can sit anywhere in the text (not just a leading
 * chip): first tracked mention still present in the text wins ("first, not
 * last", matching web's `findCommandPos`/`collectCommandName`), and the
 * two halves of the sentence around it are rejoined into `args` exactly the
 * way `serialize.ts`'s `commandSplit` does.
 */

import type { Command } from '@/lib/opencode/hooks/use-opencode-data';

export const SKILL_TRIGGER = '#';

export interface SkillTriggerMatch {
  query: string;
  triggerPos: number;
}

export interface TrackedSkillMention {
  label: string;
}

/** A minimal skill row — just what the `#` menu shows and matches against. */
export interface SkillSource {
  name: string;
  description?: string;
}

/**
 * Walk backward from the cursor to find a live "#query" the user is typing.
 *
 * Mirrors `useMentions.ts`'s `handleTextChange` "@" walk exactly: the
 * trigger must sit at the start of a word (preceded by a space, a newline,
 * or the start of the text), and the word up to the cursor must not itself
 * contain a space or newline.
 */
export function detectSkillTrigger(text: string, cursorPos: number): SkillTriggerMatch | null {
  const pos = Math.min(cursorPos, text.length);
  for (let i = pos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n') return null;
    if (ch === SKILL_TRIGGER) {
      const charBefore = i > 0 ? text[i - 1] : ' ';
      if (charBefore === ' ' || charBefore === '\n' || i === 0) {
        return { query: text.slice(i + 1, pos), triggerPos: i };
      }
      return null;
    }
  }
  return null;
}

/** Case-insensitive filter over name + description, same shape as `useMentions`'s agent/session filters. */
export function filterSkills(skills: SkillSource[], query: string): SkillSource[] {
  const q = query.toLowerCase();
  if (!q) return skills;
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q),
  );
}

/**
 * Replace the live "#query" at `trigger.triggerPos` with the picked skill's
 * "#name " — same shape as `useMentions.ts`'s `selectMention`.
 */
export function insertSkillToken(text: string, trigger: SkillTriggerMatch, skillName: string): string {
  const before = text.slice(0, trigger.triggerPos);
  const after = text.slice(trigger.triggerPos + 1 + trigger.query.length);
  return `${before}${SKILL_TRIGGER}${skillName} ${after}`;
}

/**
 * Drop tracked mentions whose "#label" text no longer appears in `text` —
 * same rule `useMentions.ts`'s `handleTextChange` applies to "@label":
 * deleting the visible token (backspace, selecting and typing over it, …)
 * untracks it.
 */
export function pruneSkillMentions(text: string, mentions: TrackedSkillMention[]): TrackedSkillMention[] {
  return mentions.filter((m) => text.includes(`${SKILL_TRIGGER}${m.label}`));
}

export type SkillSubmissionPlan =
  | { kind: 'command'; command: Command; args?: string }
  | { kind: 'message'; text: string };

/**
 * Resolve a draft that may carry a `#skill` token into what actually goes on
 * the wire.
 *
 * This is `planDraftSubmission`'s mirror (see this file's header comment):
 * the first tracked mention still present in `text` wins; its name is
 * re-resolved against the LIVE `commands` list (not the list at pick time —
 * a skill can be deleted between pick and send); a live match dispatches as
 * a structured command with the rest of the sentence as `args`; a miss
 * degrades to the plain-text `/<name> <args>` fallback; no tracked mention
 * at all (including one whose token was backspaced away) leaves `text`
 * untouched, trimmed.
 *
 * A second `#skill` token is left in the returned text as literal
 * characters, the same "no-op" web leaves a second `/` chip as — reordering
 * which command the user meant to run is worse than ignoring the extra.
 *
 * `hasAttachments`: files or `@` mentions ride with the draft. A command
 * dispatch (`POST /session/:id/command`) carries only its name and args, so
 * it would drop them. The draft then goes out as a normal message with web's
 * fallback text `/<name> <args>`, and the normal send path uploads the files
 * and keeps the mentions.
 */
export function resolveSkillSubmission({
  text,
  mentions,
  commands,
  hasAttachments = false,
}: {
  text: string;
  mentions: TrackedSkillMention[];
  commands: Command[];
  hasAttachments?: boolean;
}): SkillSubmissionPlan {
  const trimmed = text.trim();

  // First occurrence IN THE TEXT wins, not first-tracked — matches web's
  // position-based `findCommandPos` ("first, not last").
  let winner: { label: string; index: number } | null = null;
  for (const m of mentions) {
    const token = `${SKILL_TRIGGER}${m.label}`;
    const idx = text.indexOf(token);
    if (idx === -1) continue;
    if (!winner || idx < winner.index) winner = { label: m.label, index: idx };
  }

  if (!winner) return { kind: 'message', text: trimmed };

  const token = `${SKILL_TRIGGER}${winner.label}`;
  const before = text.slice(0, winner.index).trim();
  const after = text.slice(winner.index + token.length).trim();
  const args = [before, after].filter(Boolean).join(' ');

  const command = commands.find((c) => c.source === 'skill' && c.name === winner!.label);
  if (command && !hasAttachments) return { kind: 'command', command, args: args || undefined };

  return { kind: 'message', text: `/${winner.label} ${args}`.trim() };
}

/**
 * Send while a suggestion menu (`#` skills, `@` mentions) is open: it only
 * dismisses the menu when the menu has rows on screen. A trigger with no
 * match (a draft ending in `#word` that names no skill) draws no menu, so
 * Send sends.
 */
export function suggestionMenuTakesSubmit({ isOpen, itemCount }: { isOpen: boolean; itemCount: number }): boolean {
  return isOpen && itemCount > 0;
}
