/**
 * Per-episode narrator casting (no channel-wide voice, no human voice gate). The sound-editor searches
 * the ElevenLabs Voice Library by the channel's casting rule
 * (`channel.yaml → voice.casting`: language, use case, sort, model, plus the filters below), picks the
 * eligible voice that best fits the episode, and adopts it with a reason. The cast lives in the episode
 * (`03-script/voice.json`); `channel.yaml` holds only the rule.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import { channel } from "../config";
import { load, readJson, writeJson } from "../lib/io";
import { ep } from "../lib/paths";
import { VoiceCast } from "../schemas";
import { elevenlabsGet } from "./elevenlabs";

const LibraryVoice = z
  .object({
    voice_id: z.string(),
    name: z.string(),
    accent: z.string().nullish(),
    gender: z.string().nullish(),
    age: z.string().nullish(),
    descriptive: z.string().nullish(),
    use_case: z.string().nullish(),
    description: z.string().nullish(),
    rate: z.number().nullish(),
    fiat_rate: z.number().nullish(),
    notice_period: z.number().nullish(),
    usage_character_count_1y: z.number().nullish(),
    verified_languages: z.array(z.object({ model_id: z.string().nullish() }).passthrough()).nullish(),
  })
  .passthrough();
type LibraryVoice = z.infer<typeof LibraryVoice>;

/** What an agent can judge a voice by (it can't hear previews). */
const brief = (v: LibraryVoice) => ({
  voice_id: v.voice_id,
  name: v.name,
  accent: v.accent,
  gender: v.gender,
  age: v.age,
  descriptive: v.descriptive,
  use_case: v.use_case,
  description: v.description,
  usage_character_count_1y: v.usage_character_count_1y,
});
type Brief = ReturnType<typeof brief>;
type Candidates = { searched_at: string; rule: ReturnType<typeof channel>["voice"]["casting"]; eligible: Brief[]; excluded: (Brief & { reason: string })[] };

/** Why the casting rule skips a voice, or undefined when it is eligible. */
function exclusion(v: LibraryVoice, model: string): string | undefined {
  if ((v.rate ?? 1) > 1 || v.fiat_rate != null) return "custom rate: costs more per character than a standard voice";
  if (!v.notice_period) return "no notice period: the owner could withdraw it without warning";
  if (!(v.verified_languages ?? []).some((l) => l.model_id === model)) return `not verified on ${model}`;
  return undefined;
}

/** Search the Voice Library by the channel's casting rule; writes the episode's candidates, eligible most-used first. */
export async function searchLibrary(slug: string): Promise<Candidates> {
  const rule = channel().voice.casting;
  const q = new URLSearchParams({ language: rule.language, use_cases: rule.use_case, sort: rule.sort });
  const body = (await (await elevenlabsGet(`/v1/shared-voices?${q}`)).json()) as { voices: unknown[] };
  const voices = body.voices.map((v) => LibraryVoice.parse(v));
  const byUse = (a: LibraryVoice, b: LibraryVoice) => (b.usage_character_count_1y ?? 0) - (a.usage_character_count_1y ?? 0);
  const result: Candidates = {
    searched_at: new Date().toISOString(),
    rule,
    eligible: voices.filter((v) => !exclusion(v, rule.model_id)).sort(byUse).map(brief),
    excluded: voices.flatMap((v) => {
      const reason = exclusion(v, rule.model_id);
      return reason ? [{ ...brief(v), reason }] : [];
    }),
  };
  writeJson(ep(slug).voiceCandidates, result);
  return result;
}

/** Cast the episode's narrator from its last library search. Shared voices synthesise without being added to the account. */
export async function adoptLibrary(slug: string, voiceId: string, opts: { by: string; reason: string }): Promise<VoiceCast> {
  const p = ep(slug);
  if (!existsSync(p.voiceCandidates)) throw new Error(`no library search for ${slug} yet: run \`yt cast library ${slug}\``);
  const c = readJson<Candidates>(p.voiceCandidates);
  const v = c.eligible.find((x) => x.voice_id === voiceId);
  if (!v) {
    const why = c.excluded.find((x) => x.voice_id === voiceId)?.reason;
    throw new Error(why ? `${voiceId} is excluded by the casting rule: ${why}` : `${voiceId} is not in ${slug}'s last library search`);
  }
  const cast = VoiceCast.parse({
    source: "library",
    ...v,
    model_id: c.rule.model_id,
    reason: opts.reason,
    decided_by: opts.by,
    cast_at: new Date().toISOString(),
  });
  writeJson(p.voiceCast, cast);
  return cast;
}

/** The episode's narrator; throws with the next step when it hasn't been cast. */
export function episodeCast(slug: string): VoiceCast {
  const p = ep(slug);
  if (!existsSync(p.voiceCast)) throw new Error(`${slug} has no narrator yet: run \`yt cast library ${slug}\` then \`yt cast adopt ${slug} <voice_id> --by <agent> --reason ".."\``);
  return load(VoiceCast, p.voiceCast);
}
