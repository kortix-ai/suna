# Mobile ASO mockup studies

Date: 2026-10-02
Status: Direction approved. Written brief awaiting review.
Canonical branch: `revamp/mobile-ui-13`.

## Objective

Improve the 80 mobile mockup studies in Paper. Show useful results and active
moments through static composition. These are promotional concepts, not new
app functionality and not verified production screenshots.

The user approves conceptual presentation improvements. The app remains
recognizable. Larger result previews and layered content can depart from the
current transcript layout. No physical interaction or animation is required.

## Scope and protected surfaces

- Edit only the mockup collection below the eight original iOS assets.
- Keep eight families with ten visible variants per family.
- Keep every existing phone's dimensions, aspect ratio, position, edge path,
  camera path, and screen aperture.
- Do not edit the original iOS 01–08 assets, titles, backgrounds, or shaders.
- Keep the approved Notion authorization component's layout and wording.
  Improve context around it, not its dialog internals.
- Keep the project's drawer icons, control sizes, rings, chevrons, badge
  rules, and navigation structure. Do not replace them with illustrative icons.
- Use Roobert only, as requested. Use existing shared mobile color roles.
- Start in light mode. Review the new surfaces in dark mode before completion.
- Do not change app source, backend behavior, or the brand token system.
- Keep replaced design content recoverable. Do not delete the whole collection.

## Design direction

Mood: editorial, with a calm product shell and one prominent result.

Each study has one focal element. Useful content creates personality.
Color reports state or belongs to generated content and third-party artwork.
Emoji can identify content, such as a trip plan. Do not scatter decorative
emoji across controls, add confetti, or introduce unrelated gradient chrome.

Use the current phone shell, header, composer, and navigation as the anchor.
Use a larger generated result, expanded excerpt, selected state, or raised
content surface to suggest an interaction that has just happened.

Body copy stays short. Remove redundant introductions and repeated summaries.
Use one primary action per focal element. Do not add an inert control unless
the study label identifies it as a proposed component.

New result surfaces use the existing neutral surface ladder. Floating surfaces
use restrained elevation and a hairline that remains visible in dark mode.
In-flow surfaces stay flat. Nested corners must be concentric.

Use the existing type scale: normal body, medium labels, semibold titles.
Do not enlarge every element. Keep native controls at their source geometry.
Set new content on the mobile 4pt spacing grid. Use 16pt screen edges and
20pt horizontal / 16pt vertical padding for roomy result sections.

## Meeting example

The selected conversation study currently gives the introductory sentence,
numbered bullets, and Markdown file row similar emphasis. Replace that content
treatment with one prominent generated summary preview.

- Conversation request: “Summarize these meeting notes.”
- Response: “Your meeting summary is ready.”
- Preview title: “Coffee catch-up”.
- Preview metadata: “Today · 11:30 am”.
- Section: “Decisions”.
- Decision 1: “Keep the first version focused.”
- Decision 2: “Test the draft before adding more.”
- Section: “Next step”.
- Next step: “Share the revised plan on Friday.”
- Primary action: “Open summary”.

The preview is the largest content surface. A small document mark and a
completed-state mark can support it. A partial second page can suggest more
content without covering the readable text. Keep the composer visible.

This enlarged transcript preview is a concept. The current mobile show result
is a compact file row that opens its preview. Do not describe the enlarged
preview as a shipped transcript component.

## Eight families

| Family | Focal treatment | Keep recognizable |
| --- | --- | --- |
| 01 · Start a task | A prepared request with meaningful attached context; restrained content previews suggest what the task can produce | Home shell, composer, native attachment controls |
| 02 · Conversation | Large generated summary, plan, or answer preview; short request and response | Thread header, user bubble, composer, output context |
| 03 · Follow the work | One active or completed activity moment with a readable result excerpt | Native activity sheet, timeline markers, source spacing and corners |
| 04 · Choose a model | Selected model state over a concrete task; a visible answer excerpt explains the context | Actual picker rows, provider marks, checks and native controls |
| 05 · Connect tools | Prominent connection moment with task context or a connected result behind it | Approved authorization layout and accurate third-party marks |
| 06 · Add context | Legible attachment thumbnails beside a specific request; a result excerpt shows the payoff | Native attachment strip, composer and file controls |
| 07 · Preview the result | A populated generated page, document, or planner with strong internal hierarchy | Actual browser/file-preview chrome |
| 08 · Projects | Meaningful project/session names and varied active states; result context remains secondary | Exact drawer icons, row geometry, counts, rings and chevrons |

## Variant structure

Ten variants in each family must change more than the headline or tint.
Use these synthetic content themes where the family supports them:

1. Meeting summary.
2. Weekly plan.
3. Weekend itinerary.
4. Reading notes.
5. Shopping checklist.
6. Event plan.
7. Research comparison.
8. Budget overview.
9. Personal website.
10. Daily recap.

Within each family, vary the focal composition: one large preview, a focused
excerpt, a content-led sheet, a selected state, or a completed result.
Do not fabricate provider integrations or capabilities to fill the matrix.
The model and connector families use only the catalog entries already present
in the source or existing approved designs.

## References and accuracy boundary

Granola informs the prominent contextual card and readable everyday content.
Notion informs familiar content icons. Paste informs focused result details.
mymind informs content-led color. Neuecast informs one active moment per scene.
Do not copy their visual assets, logos, testimonials, or app-specific widgets.

The review collection must say “Promotional UI concepts”. Label unshipped
component proposals beside the study, outside the phone. Preserve the existing
calendar lock-screen concept labels. These concepts require an accuracy pass
against the released app before store submission. Do not export or publish
them as production screenshots in this task.

## Delivery and verification

1. Capture fresh original-asset and phone-geometry baselines before edits.
2. Build the meeting study first and inspect its screenshot.
3. Build one representative from each remaining family and inspect each.
4. Apply the treatment across ten variants per family, with distinct content.
5. Inspect every variant for wrapping, hierarchy, spacing, icon lanes,
   contrast, layering, and content fit. Correct defects before moving on.
6. Review new color-bearing components in both themes. Restore light mode.
7. Compare all eight original assets and all 80 phone shells with the baseline.
8. Confirm eight families, ten visible variants each, with no lost approved
   connector component and no altered native drawer geometry.
9. Finish the Paper editing session and report the changed collection,
   verification results, and conceptual-versus-shipped boundary.

No local runtime or deployment change is part of this task. Canvas inspection
does not prove that a proposed component ships in the mobile app.
