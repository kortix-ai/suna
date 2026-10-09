# Generative UI — Phase 0 evaluation results

Each run appends one section: the gate, one row per model, and the failing cases (issue codes only).
Raw replies are in `output/genui-eval/<timestamp>.json` (gitignored). Script: `scripts/eval.ts`.

## Run 2026-10-09T11:54:21.921Z — prompt 244a8521

Gate: valid ≥ 97.0%, overuse ≤ 10.0%, underuse ≤ 25.0%, forbidden ≤ 1, errors = 0.

| Model | Cases | Blocks | Valid | Overuse | Underuse | Forbidden | Median completion tokens | Errors | Go |
|---|---|---|---|---|---|---|---|---|---|
| `deepseek-v4.1-flash` | 46 | 28 | 82.1% | 0.0% | 0.0% | 0 | 382 | 0 | NO |
| `glm-5.3-flash` | 46 | 28 | 82.1% | 0.0% | 0.0% | 0 | 737 | 0 | NO |
| `kimi-k3` | ERROR: kimi-k3 ui-revenue-quarters: 3 attempts failed (HTTP 503) | — | — | — | — | — | — | — | NO |

Failing cases (issue codes only):

- `deepseek-v4.1-flash` edge-faq: schema:AccordionItem, schema:AccordionItem, schema:AccordionItem, schema:AccordionItem, schema:AccordionItem, schema:Accordion, schema:Stack, no-root:
- `deepseek-v4.1-flash` ui-places-map: schema:Map
- `deepseek-v4.1-flash` ui-sales-region: schema:Stat
- `deepseek-v4.1-flash` ui-signups-monthly: schema:Stat
- `deepseek-v4.1-flash` ui-stats-and-tip: schema:Stat, schema:Stat, schema:Stat, schema:StatRow
- `glm-5.3-flash` edge-big-table: schema:Table, schema:Table
- `glm-5.3-flash` edge-faq: schema:AccordionItem, schema:AccordionItem, schema:AccordionItem, schema:AccordionItem, schema:AccordionItem, schema:Accordion
- `glm-5.3-flash` edge-map-no-coords: schema:Callout
- `glm-5.3-flash` ui-itinerary-tabs: schema:Stack, schema:Tab, schema:Stack, schema:Tab, schema:Stack, schema:Tab, schema:Tabs
- `glm-5.3-flash` ui-places-map: schema:Map

### Notes for run 2026-10-09T11:54:21.921Z — Provisional: local stand-in models (Jay's 4 models are not served by the local gateway)

- Gateway: local API `http://localhost:20908/v1/llm/chat/completions`, authenticated with a personal access token. Step 1 returned `200` for `deepseek-v4.1-flash`.
- Models run: `deepseek-v4.1-flash`, `glm-5.3-flash`, `kimi-k3` (the only models the local gateway serves).
- `kimi-k3` did not complete. Case `ui-revenue-quarters` failed 3 attempts with HTTP 503 `model_unavailable` ("kimi-k3 is temporarily unavailable"). Two direct `curl` calls afterward returned the same 503. The row is an infrastructure error, not a quality result. Re-run `kimi-k3` alone when the model is available.
- Result: 2 of 2 completed models fail the gate (valid 82.1% against ≥ 97.0%). Overuse, underuse, and forbidden are at gate for both (0.0%, 0.0%, 0).
- Raw replies: `output/genui-eval/2026-10-09T11-54-21-921Z-<model>.json` (gitignored).

#### Failure classification (all 5 failing cases per model were read)

Categories: invalid syntax, limit breach, overuse, underuse, invented data. No model had overuse or underuse failures.

| Model | Case | Class | Cause |
|---|---|---|---|
| `deepseek-v4.1-flash` | `edge-faq` | invalid syntax | `AccordionItem("title", ["text"])`: children are plain strings. `children` accepts blocks only, and the catalog has no text component. |
| `deepseek-v4.1-flash` | `ui-places-map` | invalid syntax | `Map([..], "source", 5)`: zoom is written in the third slot, which is `route`. Zoom is the fourth argument. |
| `deepseek-v4.1-flash` | `ui-sales-region` | invalid syntax | `Stat("Total sales", "1,220", unit "units")`: named argument without `=`. Arguments are positional. |
| `deepseek-v4.1-flash` | `ui-signups-monthly` | invalid syntax | `Stat("Change, Jan to Jun", "+119%", trend="up", unit="%")`: named arguments. |
| `deepseek-v4.1-flash` | `ui-stats-and-tip` | limit breach | `delta` over 16 characters: `"+vs ~22% benchmark"` (18) and `"above <0.2% target"` (18). Also invented data (not flagged by the scorer): the benchmarks (~22%, ~2.5%, <0.2%) are not in the tool result. |
| `glm-5.3-flash` | `edge-big-table` | invalid syntax | `Table(cols, rows, "caption", "Rows r1–r40")`: 4 arguments, `Table` takes 3. The model split 80 rows into two 40-row tables correctly. |
| `glm-5.3-flash` | `edge-faq` | invalid syntax | Same as deepseek: plain strings as `AccordionItem` children. |
| `glm-5.3-flash` | `edge-map-no-coords` | invalid syntax | `Callout("info", "body", title="Local tip")`: named argument. |
| `glm-5.3-flash` | `ui-itinerary-tabs` | invalid syntax | `Stack(["Morning: ...", ...], "col")`: plain strings as `Stack` children inside `Tab`. Cascades to `Tab` and `Tabs`. |
| `glm-5.3-flash` | `ui-places-map` | invalid syntax | `Map([..], "source", 6)`: zoom in the `route` slot. |

Totals: 9 of 10 failing cases are invalid syntax (positional-arity or argument-style errors); 1 is a limit breach. The dominant cause is the model not following the positional-argument rules, not a wrong choice of component.

#### Spot-check: rule 1 and component fit

| Case | Model | Prose before first block | Component fit |
|---|---|---|---|
| `ui-rank-hotels` | `deepseek-v4.1-flash` | Yes (2 sentences) | `Callout` + `Compare` + `RankedList`. Fits a recommendation, but `Compare` and `RankedList` repeat the same ranking. Block parses. |
| `ui-rank-hotels` | `glm-5.3-flash` | Yes (2 sentences) | `Callout` + `Compare` with `winner`. Fits. No `RankedList`. Block parses. |
| `ui-stats-and-tip` | `deepseek-v4.1-flash` | Yes (2 sentences) | `StatRow` + `RankedList` for next actions. Correct components. Fails on `delta` length. |
| `ui-stats-and-tip` | `glm-5.3-flash` | Yes (1 sentence) | `StatRow` only. The next-steps list is markdown prose, not a block. Block parses. |

Rule 1 holds in 4 of 4 replies. No `Table` was used where `RankedList` fits.

#### Prompt-rule changes to consider (not applied; the prompt is unchanged in this run)

1. Add a rule: "Arguments are positional. Never write `name=value` or `name value`. Optional arguments are skipped only by filling every earlier slot." Covers 5 of 10 failures (`unit "units"`, `trend=`, `title=`, and the `Table` extra argument). The generated prompt already has a similar sentence, but it shows colon syntax only; show an `=` counter-example.
2. Add a rule: "`Stack`, `Tab`, and `AccordionItem` children are references to components, never strings. Put text in `Card` `body` or `Callout` `body`." Covers 3 of 10 failures (`edge-faq` twice, `ui-itinerary-tabs`). Add a `Tabs` or `Accordion` example to `EXAMPLES` that shows `Card` children.
3. Add a rule for `Map`: "`zoom` is the fourth argument. Write `Map(markers, source)` and omit `route` and `zoom` unless needed." Covers 2 of 10 failures. Also add: "`Stat` `delta` is at most 16 characters; put long comparisons in prose." Covers 1 of 10.

## Run 2026-10-09T12:04:13.679Z — prompt 806347a8

Gate: valid ≥ 97.0%, overuse ≤ 10.0%, underuse ≤ 25.0%, forbidden ≤ 1, errors = 0.

| Model | Cases | Blocks | Valid | Overuse | Underuse | Forbidden | Median completion tokens | Errors | Go |
|---|---|---|---|---|---|---|---|---|---|
| `deepseek-v4.1-flash` | 46 | 28 | 92.9% | 0.0% | 3.8% | 0 | 369 | 0 | NO |
| `glm-5.3-flash` | 46 | 29 | 96.6% | 0.0% | 0.0% | 0 | 749 | 0 | NO |

Failing cases (issue codes only):

- `deepseek-v4.1-flash` ui-pros-cons: underuse
- `deepseek-v4.1-flash` ui-restaurants-map: schema:Map
- `deepseek-v4.1-flash` ui-stats-and-tip: schema:Stat
- `glm-5.3-flash` ui-places-map: schema:Map

### Notes for run 2026-10-09T12:04:13.679Z — Provisional re-run after prompt rules (local stand-in models)

- Prompt 806347a8 adds three rules (commit 450a8854db): positional arguments only, component references as `Stack`/`Tab`/`AccordionItem` children, argument order and limits.
- Models: `deepseek-v4.1-flash`, `glm-5.3-flash`. `kimi-k3` still returned HTTP 503 on a single curl before the run, so it was not included.
- Valid rate before and after: `deepseek-v4.1-flash` 82.1% to 92.9%; `glm-5.3-flash` 82.1% to 96.6%. Gate is 97.0%. Both models still fail it. `glm-5.3-flash` misses by one invalid block (28 of 29).
- Failing cases: deepseek 5 to 3, glm 5 to 1 (10 to 4 in total).
- Fixed: all string-children failures (`edge-faq`, `ui-itinerary-tabs`), all named-argument failures, and the `Table` arity failure.

| Model | Case | Class | Cause |
|---|---|---|---|
| `deepseek-v4.1-flash` | `ui-restaurants-map` | invalid syntax | `Map([..], "source", "", 12)`: an empty string fills the `route` slot (expects `number[][]`) to reach `zoom`. The model followed "fill every earlier argument" literally with a wrong placeholder. |
| `deepseek-v4.1-flash` | `ui-stats-and-tip` | limit breach | `Stat` `delta` `"+6 pts vs typical"` is 17 characters (max 16). The rule says 16; the model does not count. Also invented data (not flagged by the scorer): "typical" benchmark. |
| `deepseek-v4.1-flash` | `ui-pros-cons` | underuse | The model asked which frameworks were meant and wrote no block. The prompt names placeholders `Framework One` and `Framework Two`; this is a clarification reply, not a format error. |
| `glm-5.3-flash` | `ui-places-map` | invalid syntax | `Map([..], "source", 6)`: zoom still lands in the `route` slot, in spite of the new rule. |

Remaining cause: `Map` argument order. 2 of the 4 remaining failures (and 2 of 10 before) put `zoom` in the `route` slot or fill it with a wrong placeholder. Options for the controller (not applied): (1) swap the schema to `Map(markers, source, zoom?, route?)`, since `zoom` is used more than `route`; (2) remove `route` from v1; (3) add a `Map` example with `zoom` to `EXAMPLES`.
