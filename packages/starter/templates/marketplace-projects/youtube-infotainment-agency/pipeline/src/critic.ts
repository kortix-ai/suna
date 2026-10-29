/**
 * Critic review files. Most stages have one (`qa/<stage>-review.json`); scenes have one per scene
 * (`qa/scenes-<scene>-review.json`), which the verdict combines, so nobody writes an aggregate by hand.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "./lib/io";
import { ep } from "./lib/paths";
import { Review, reviewVerdict } from "./schemas";

/** The stage's review if there is one file for the whole stage, else one review per part (scene). */
export function stageReviews(slug: string, stage: string): { id: string; review: Review }[] {
  const p = ep(slug);
  if (existsSync(p.review(stage))) return [{ id: stage, review: load(Review, p.review(stage)) }];
  if (!existsSync(p.qa)) return [];
  const prefix = `${stage}-`, suffix = "-review.json";
  return readdirSync(p.qa)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix) && f.length > prefix.length + suffix.length)
    .sort()
    .map((f) => ({ id: f.slice(prefix.length, -suffix.length), review: load(Review, join(p.qa, f)) }));
}

/** The pass rule (`reviewVerdict`) over every review of the stage; `failing` names what must be fixed. */
export function stageVerdict(slug: string, stage: string) {
  const reviews = stageReviews(slug, stage);
  if (!reviews.length) {
    const qa = ep(slug).qa;
    const found = existsSync(qa) ? readdirSync(qa).filter((f) => f.endsWith("-review.json")) : [];
    throw new Error(
      `no critic review on file for ${stage}: expected qa/${stage}-review.json or qa/${stage}-<scene>-review.json` +
        ` (found: ${found.length ? found.join(", ") : "none"})`,
    );
  }
  const verdicts = reviews.map(({ id, review }) => ({ id, ...reviewVerdict(review) }));
  const sum = (k: "blockers" | "majors" | "minors") => verdicts.reduce((n, v) => n + v[k], 0);
  return {
    pass: verdicts.every((v) => v.pass),
    blockers: sum("blockers"),
    majors: sum("majors"),
    minors: sum("minors"),
    auto_fail: verdicts.flatMap((v) => v.auto_fail),
    overall: Number((verdicts.reduce((n, v) => n + v.overall, 0) / verdicts.length).toFixed(2)),
    failing: verdicts.filter((v) => !v.pass).map((v) => v.id),
  };
}
