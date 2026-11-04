// Who the assistant is in one call, and how it changes: its name, its voice, its look (an emoji or an image link the
// call page shows) and its style (how it behaves, in a sentence or two). Set from the call page (?agent=, ?voice=, a
// "persona" message) or by the assistant itself when asked ("call yourself Nova and use a deeper voice"): it starts
// its reply with a tag, [set name="Nova" voice="deep calm male"], which is applied and never read aloud or shown.
// mode: how it takes part, set by voice: 'normal'; 'listen' (says nothing, keeps the transcript, until named and told to
// speak); 'named' (answers only turns that name it).
export type Mode = 'normal' | 'listen' | 'named'
export type Persona = { name: string; voice?: string; look?: string; style?: string; mode?: Mode; rate?: number } // rate: speaking speed, 0.5-1.5
import { ours, voiceName } from './speech'

/** A [set ...] tag anywhere in a reply (attributes in double quotes; one tag per reply is enough). */
// A quoted value may hold "]" ([set style="like a pirate [arr]"]): quotes are skipped whole.
export const SET = /\[set\b(?:[^\]"]|"[^"]*"){0,1200}\]/i
const FIELDS = ['name', 'voice', 'look', 'style'] as const

/** The attributes of a [set ...] tag: only the ones given, trimmed and bounded. */
export function parseSet(tag: string): Partial<Persona> {
  const out: Partial<Persona> = {}
  for (const m of tag.matchAll(/\b(name|voice|look|style|mode|rate)\s*=\s*"([^"]{0,1000})"/gi)) {
    const k = m[1]!.toLowerCase() as (typeof FIELDS)[number] | 'mode' | 'rate'
    const v = m[2]!.trim()
    if (k === 'rate') { const r = Number(v); if (Number.isFinite(r) && r > 0) out.rate = Math.min(1.5, Math.max(0.5, Math.round(r * 100) / 100)) }
    else if (k === 'mode') { const x = v.toLowerCase(); if (x === 'normal' || x === 'listen' || x === 'named') out.mode = x }
    else if (k === 'name') { if (/^[\p{L}][\p{L}\p{N} .'-]{0,30}$/u.test(v)) out.name = v }
    else if (k === 'look') { if (/^(https?:\/\/\S{1,500}|\p{Extended_Pictographic}[\p{Extended_Pictographic}‍️]{0,8}|)$/u.test(v)) out.look = v }
    else out[k] = v.slice(0, k === 'style' ? 600 : 80)
  }
  return out
}

/** What every turn is told about who it is in this call (how it changes is in the call note, src/meta.ts metaNote). */
export function personaNote(p: Persona, base: string): string {
  return `\n\n(Who you are in this call: your name is ${p.name}${p.name !== base ? ` (not ${base})` : ''}; say it only when they ask who you are, never introduce yourself.${p.style ? ` Your style, as set in this call: ${p.style}` : ''}` +
    `${p.mode === 'listen' ? ' You are listening only now and they just named you: if they tell you to speak again, reply [set mode="normal"] and a few words so they hear you are back ("Sure, I\'m back."); if they ask you something directly, answer it in a sentence and keep listening; otherwise reply with exactly (nothing).' : p.mode === 'named' ? ' You answer only turns that name you now, as this one does.' : ''})`
}

/** A short list of voices to offer, from the catalog, for the note: this deployment's own voices first ("<workspace>__<name>"
 * of INWORLD_WORKSPACE, by name), then one stock voice per kind. */
export function someVoices(all: { id: string; about: string }[]): string {
  const pick = ['Ashley', 'Chloe', 'Alex', 'Bianca', 'Casey', 'Clive', 'Elliot', 'Imogen', 'Lauren', 'Marcus', 'Selene', 'Sienna', 'Theodore', 'Tyler', 'Wade', 'Zoe']
  const own = all.filter((v) => v.id.includes('__') && ours(v.id)).map((v) => voiceName(v.id)).slice(0, 8)
  const have = all.length ? pick.filter((id) => all.some((v) => v.id === id)) : pick
  return [...new Set([...own, ...have])].join(', ')
}
