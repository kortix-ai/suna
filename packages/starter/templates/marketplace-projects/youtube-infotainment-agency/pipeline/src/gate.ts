/**
 * Human gates. `yt gate request` writes a review packet (qa/gate-<gate>.md) and submits it to the Kortix
 * review inbox; `yt gate sync` reads the person's verdict back into episode.yaml.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brollBudget } from "./broll";
import { stageReviews, stageVerdict } from "./critic";
import { loadEpisode, requestGate, decideGate, saveEpisode, totalCost, type Gate } from "./episode";
import { readReview, submitReview } from "./lib/review";
import { load, readJson, writeText } from "./lib/io";
import { ep } from "./lib/paths";
import { Brief, Claims, Package, Review, reviewVerdict, Script, Storyboard, Timing } from "./schemas";
import { lintScript } from "./script";
import { sceneWindows } from "./timing";
import { primaryShare } from "./claims";

const STAGE_FOR_GATE: Record<Gate, string> = { topic: "topic", script: "script", storyboard: "storyboard", final: "render" };

function reviewSection(slug: string, stage: string): string[] {
  const reviews = stageReviews(slug, stage);
  if (!reviews.length) return ["_No critic review on file._", ""];
  return reviews.flatMap(({ id, review: r }) => [
    ...(id === stage ? [] : [`### ${id}`, ""]),
    `**Critic:** ${r.overall.toFixed(1)}/5 — ${reviewVerdict(r).pass ? "PASS" : "FAIL"}${r.auto_fail.length ? ` (auto-fail: ${r.auto_fail.join("; ")})` : ""}`,
    "",
    ...Object.entries(r.scores).map(([k, v]) => `- ${k}: ${v}/5`),
    "",
    ...(r.issues.length ? ["Open issues:", ...r.issues.map((i) => `- [${i.severity}] ${i.where}: ${i.problem} → ${i.fix}`), ""] : []),
  ]);
}

export function packet(slug: string, gate: Gate): string {
  const p = ep(slug);
  const state = loadEpisode(slug);
  const L: string[] = [`# ${state.title} — ${gate} gate`, "", `Episode \`${slug}\` · spend so far $${totalCost(state)}`, ""];

  if (gate === "topic") {
    const b = load(Brief, p.brief);
    L.push(`**Question:** ${b.question}`, "", `**One-liner:** ${b.one_liner}`, "", `**Audience:** ${b.audience}`, "",
      `**Misconception → resolution:** ${b.misconception} → ${b.resolution}`, "", `**Our angle (originality ${b.originality.score}/5):** ${b.originality.our_angle}`, "",
      "Existing coverage:", ...b.originality.existing_coverage.map((c) => `- [${c.title}](${c.url}) — ${c.channel}${c.views ? `, ${c.views.toLocaleString("en-US")} views` : ""}`), "",
      `**Why now:** ${b.why_now}`, "", `**Target length:** ${b.target_minutes} min`, "",
      ...(b.risks.length ? ["Risks:", ...b.risks.map((r) => `- ${r}`), ""] : []));
  }

  if (gate === "script") {
    const script = load(Script, p.script);
    const claims = load(Claims, p.claims);
    const { issues, stats } = lintScript(script, claims, existsSync(p.brief) ? load(Brief, p.brief) : undefined);
    const counts = claims.claims.reduce<Record<string, number>>((a, c) => ({ ...a, [c.status]: (a[c.status] ?? 0) + 1 }), {});
    L.push(`**${stats.beats} beats · ${stats.words} words · ~${(stats.est_seconds / 60).toFixed(1)} min · hook ~${stats.hook_seconds}s**`, "",
      `Claims: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")} · ${Math.round(primaryShare(claims) * 100)}% backed by a primary source`, "",
      ...(issues.length ? ["Lint:", ...issues.map((i) => `- ${i.level} ${i.where}: ${i.msg}`), ""] : ["Lint: clean", ""]),
      "---", "", existsSync(p.scriptMd) ? readFileSync(p.scriptMd, "utf8") : "_script.md missing_", "");
  }

  if (gate === "storyboard") {
    const sb = load(Storyboard, p.storyboard);
    const timing = load(Timing, p.timing);
    const wins = sceneWindows(sb, timing);
    const budget = brollBudget(sb, wins, timing.total);
    L.push(`**${sb.scenes.length} scenes over ${(timing.total / 60).toFixed(1)} min** · gen b-roll ${budget.seconds}s (${(budget.fraction * 100).toFixed(0)}%)`, "",
      ...(sb.style_notes ? [sb.style_notes, ""] : []),
      "| scene | beats | type | sec | concept |", "|---|---|---|---|---|",
      ...sb.scenes.map((s) => `| ${s.id} | ${s.beats.join(" ")} | ${s.type} | ${wins.find((w) => w.id === s.id)!.duration.toFixed(1)} | ${s.concept.replaceAll("|", "/")} |`), "",
      "Style frames:", ...sb.scenes.filter((s) => s.styleframe).map((s) => `- ${s.id}: ${s.styleframe}`), "",
      ...(budget.problems.length ? ["B-roll problems:", ...budget.problems.map((x) => `- ${x}`), ""] : []));
  }

  if (gate === "final") {
    const qa = existsSync(join(p.qa, "final-qa.json")) ? readJson<any>(join(p.qa, "final-qa.json")) : null;
    const pkg = existsSync(p.pkg) ? load(Package, p.pkg) : null;
    L.push(qa ? `**Final QA: ${qa.ok ? "PASS" : "FAIL"}** · ${qa.duration}s · contact sheet \`${qa.contact_sheet}\`` : "_final-qa.json missing_", "",
      ...(qa ? qa.checks.map((c: any) => `- ${c.ok ? "✅" : c.severity === "warn" ? "⚠️" : "❌"} ${c.name}: ${c.detail}`) : []), "");
    if (pkg) {
      L.push(`**Title:** ${pkg.chosen_title}`, "", "Alternatives:", ...pkg.titles.map((t) => `- ${t.text} (${t.score}/10)`), "",
        `**Thumbnail:** ${pkg.thumbnail.concept} — text "${pkg.thumbnail.text}" · preview \`qa/thumbnail-preview.jpg\``, "",
        `**Synthetic media disclosure:** ${pkg.contains_synthetic_media ? `YES — ${pkg.synthetic_media_reason ?? ""}` : "no"}`, "");
      if (existsSync(p.descriptionTxt)) L.push("Description:", "```", readFileSync(p.descriptionTxt, "utf8"), "```", "");
    }
    L.push("Costs:", ...state.costs.map((c) => `- ${c.stage} · ${c.provider} · ${c.item}: $${c.usd}`), "");
  }

  L.push("## Critic review", "", ...reviewSection(slug, STAGE_FOR_GATE[gate]));
  // The final gate judges the whole episode, so the scene and packaging verdicts belong in the packet too:
  // scene issues still open after `critic.scene_fix_rounds` are the human's call here.
  if (gate === "final") {
    L.push("## Scenes critic review", "", ...reviewSection(slug, "scenes"));
    L.push("## Package critic review", "", ...reviewSection(slug, "package"));
  }
  // Optional showrunner notes: qa/gate-<gate>-notes.md (deviations, decisions for the human, paths).
  const notes = join(p.qa, `gate-${gate}-notes.md`);
  if (existsSync(notes)) L.push("## Showrunner notes", "", readFileSync(notes, "utf8"), "");
  L.push("---", "Approve to continue. Reject or request changes with a note; the note goes back to the stage agent.");
  return L.join("\n");
}

export async function request(slug: string, gate: Gate, opts: { submit?: boolean }) {
  const p = ep(slug);
  if (loadEpisode(slug).gates[gate].status === "approved") throw new Error(`gate ${gate} is already approved`);
  // The human sees a stage only after the critic has passed it: run the critic loop first.
  const stage = STAGE_FOR_GATE[gate];
  let verdict: ReturnType<typeof stageVerdict>;
  try {
    verdict = stageVerdict(slug, stage);
  } catch (e) {
    throw new Error(`gate ${gate}: the critic has not reviewed stage ${stage} yet. ${(e as Error).message}`);
  }
  if (!verdict.pass) {
    throw new Error(`gate ${gate}: the critic's review of ${stage} fails (${verdict.blockers} blocker, ${verdict.majors} major, auto-fail ${verdict.auto_fail.length}); fix and re-check first`);
  }
  const body = packet(slug, gate);
  writeText(p.reviewPacket(gate), body);
  const state = loadEpisode(slug);
  const reviewId = opts.submit
    ? await submitReview({
        title: `${state.title} — ${gate} gate`,
        summary: body,
        risk: gate === "final" ? "medium" : "low",
        detail: { episode: slug, gate, packet: p.reviewPacket(gate) },
        agent: "showrunner",
      })
    : undefined;
  if (opts.submit && !reviewId) console.error(`packet is at ${p.reviewPacket(gate)}`);
  requestGate(state, gate, reviewId);
  saveEpisode(state);
  return { packet: p.reviewPacket(gate), review_id: reviewId ?? null, submitted: !!reviewId };
}

/** Read the Kortix review verdict for every requested gate and apply it. */
export async function sync(slug: string) {
  const state = loadEpisode(slug);
  const out: { gate: string; result: string }[] = [];
  for (const [gate, g] of Object.entries(state.gates) as [Gate, (typeof state.gates)[Gate]][]) {
    if (g.status !== "requested" || !g.review_id) continue;
    const r = await readReview(g.review_id);
    if (!r) { out.push({ gate, result: `could not read ${g.review_id}` }); continue; }
    const { verdict, note, by } = r;
    if (/approve/.test(verdict)) { decideGate(state, gate, true, String(by), note); out.push({ gate, result: "approved" }); }
    else if (/reject|changes|dismiss/.test(verdict)) { decideGate(state, gate, false, String(by), note ?? verdict); out.push({ gate, result: `rejected (${verdict})` }); }
    else out.push({ gate, result: `pending (${verdict || "no verdict yet"})` });
  }
  saveEpisode(state);
  return out;
}

/** Critic-mode gates: decide from the stage's review file. */
export function decideFromReview(slug: string, gate: Gate) {
  const state = loadEpisode(slug);
  if (state.gates[gate].mode === "human") throw new Error(`gate ${gate} is human-only`);
  const r = load(Review, ep(slug).review(STAGE_FOR_GATE[gate]));
  const v = reviewVerdict(r);
  decideGate(state, gate, v.pass, "critic", `overall ${r.overall}; ${v.blockers} blocker, ${v.majors} major`);
  saveEpisode(state);
  return { gate, approved: v.pass, overall: r.overall };
}
