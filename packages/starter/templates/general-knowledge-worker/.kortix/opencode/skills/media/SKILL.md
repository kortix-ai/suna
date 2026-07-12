---
name: media
description: "Generate and transform media — images, video, speech, and transcription — via Kortix's media skills. Directs image-generation requests itself: decides the capability an image needs, writes the prompt, assigns reference-image roles, and holds the safety line before handing off to the replicate skill. Use whenever a task needs AI-generated or AI-edited images/video/audio, text-to-speech, or transcription, or needs a routing/prompt/safety decision for an image request (transparency, legible text/UI, in-place edit, premium polish, fast ideation, real people/brands/minors)."
defaultProjectInstall: true
---

# Media

Kortix creates and transforms media through dedicated, provider-backed skills. This skill is the map: pick the right one for the job and load it for its models, parameters, and examples. For **image generation specifically**, this skill also directs the request itself (capability routing, prompt, reference roles, safety) before handing off to the generator — see "Image Generation" below.

| Task | Use the skill | Notes |
|------|---------------|-------|
| Image generation & editing — text-to-image, style variations, inpaint/outpaint, upscale, background removal | **This skill directs it** (see "Image Generation" below), generation itself runs through **`replicate`** | Replicate API; needs `REPLICATE_API_TOKEN` |
| Video generation — text-to-video, image-to-video | **`replicate`** | pick a video model on Replicate |
| Programmatic / templated video — compositions, frame chaining, multi-scene | **`remotion`** | render with code |
| Text-to-speech, voices, multi-speaker dialogue | **`elevenlabs`** | needs `ELEVENLABS_API_KEY` |
| Audio/video transcription — speech-to-text, timestamps | **`replicate`** | run a Whisper/speech model on Replicate |
| Logos & brand marks | **`logo-creator`** | purpose-built for marks |

Load the relevant skill (e.g. `replicate`) and follow its guidance — that's the single source of truth for available models and parameters.

## When AI media is the wrong tool

AI image and video models hallucinate text and numbers, so they are **bad for charts, graphs, timelines, infographics, diagrams, or anything with precise labels.** Build those programmatically instead — Python (matplotlib/plotly) or HTML/SVG — then screenshot if you need a raster. See the `visualization` skill for charts and `design-foundations` for visual style.

## Running generation

- Renders can be slow. Kick off long jobs and keep working — don't block on them.
- One generation per tool call, so each result renders correctly and jobs can run in parallel.
- Save outputs to the workspace with clear filenames, and present them to the user with the `show` tool.

---

## Image Generation

For image requests, this skill is the director, not the camera. Generation itself runs through the **`replicate`** skill, which holds the model catalog and selects the concrete model. The job here is the four decisions that happen before any pixels exist: **what capability the image needs**, **what prompt**, **how each reference is used**, and **where the safety line sits**. Make those calls, hand a clean brief to `replicate`, and stop.

Keep the user's subject, style, mood, and intensity intact. Sharpen specificity, composition, and generation reliability — don't impose a house look.

### Engage or skip

Engage this routing/prompting process when the request needs a real judgment: capability routing, prompt construction, reference-role assignment, multi-variant planning, or a safety call.

Skip straight to `replicate` when:

- It is a trivial one-shot with no capability, format, reference, or safety question worth deciding.
- The user already specified a concrete img2img edit and no routing or prompt decision remains.
- The output should be *computed*, not generated: charts, graphs, timelines, data-driven infographics (use a script — image models hallucinate numbers and text).
- The ask is OCR, captioning, factual image search, finished-design critique, web/document layout, or an abstract "which model wins" debate with no actual image to make.

If only generation was wanted, stay light: pick the capability, shape the prompt, clear safety, then go.

### Operating rules

- Preserve the user's taste. Improve controllability, not style.
- Deliver usable output, not a prompting tutorial. Explain only when asked.
- Rationales are one sentence, included only when they help.
- A safety gate always outranks prompt quality. Resolve the gate first.
- Never invoke an interactive question tool. If something blocks you, ask the one blocking question in your final reply and stop.
- Don't reference this skill, its files, or "the rules" to the user.
- Never claim an image is ready until generation actually succeeded and the file is in the conversation.

### Step 1 — Route the capability

Generation runs through the `replicate` skill. Don't pick a raw model id — decide the **capability class** the image needs and state it, and `replicate` maps it to the best available model. Be explicit so the generator chooses correctly.

| Need | Capability to request | Why |
|---|---|---|
| Transparent background — icon, sprite, overlay, cutout, sticker | a true-alpha model + transparent/PNG-alpha output | only some models have a real alpha channel |
| Legible text, UI, labels, packaging copy, exact multi-element layout | a high text-fidelity / typography-capable model | type and structure are the hard part |
| In-place edit of a supplied image — background swap, object removal, keep original pixels | image-to-image / inpaint, source passed as a reference | a faithful edit, not a fresh generation |
| Premium / client-, board-, investor-facing, "highest quality" — no strict text | the top-quality model | maximum polish |
| Fast ideation, many variants, quick drafts | the fast / low-cost model | quick and cheap |
| Upscale, background removal, niche style / fine-tune, a specific community model | a specialized `replicate` model | purpose-built ops |

**Gates, first match wins:**

1. Safety or tool-availability constraints (resolve before anything else).
2. **Transparency required** → a true-alpha model + transparent output. If none is available, say so and ask whether to ship opaque or wait — never silently drop the alpha channel.
3. **Specialized op** (upscale, bg removal, fine-tune/LoRA, a named community model) → the matching `replicate` model.
4. **In-place pixel edit of a supplied image** → image-to-image / inpaint with the source as a reference.
5. **Legible text / UI / labels / strict layout** → a high text-fidelity model. Apply the UI-fidelity rule below first.
6. **Premium, no strict text** → the top-quality model. Don't use this gate to override transparency, text, layout, or safety needs.
7. **Fast ideation / many variants** → the fast / low-cost model.
8. None apply → let `replicate` use its default.

**Transparency outranks every other model preference** and can never be silently degraded.

**UI-fidelity rule:** only build interfaces that are fictional or user-owned. Never render a realistic clone of a real third-party product — banking, government, healthcare, identity, social, messaging, search, or finance UI.

**Honoring user preference:** if the user names a specific model, pass it to `replicate`. If it can't meet a requirement (e.g. transparency), say so in one line and pick the nearest fit. For a hard capability gap, ask before degrading rather than shipping something that misses the requirement.

**Framing & aspect ratio:** request the framing the task needs and let `replicate` map it to a size the chosen model supports. If a model is fixed-size or square-only, preserve the intended framing through the prompt and crop afterward rather than forcing an unsupported size.

For 3+ generations or multi-crop work, state the capability + per-variant framing + transparency/reference plan **before** generating.

### Step 2 — Build the prompt

Build the prompt as a ladder, climbing only as many rungs as the task needs — 3 for a simple ask, up to ~9 for a layered scene. Each rung must change the image; drop rungs that don't.

1. **Subject + action** — what it is and what it's doing.
2. **Focal hierarchy** — what the eye hits first, second, third.
3. **Composition + crop** — framing, camera distance, negative space.
4. **Lighting** — direction, contrast, time of day.
5. **Material + surface** — texture, finish, lens or render behavior.
6. **Palette + mood** — color story and emotional register.
7. **Environment** — background, and how quiet it should stay.
8. **Reference use** — what each attached image governs (see Step 3).
9. **Constraints** — the specific failure you're heading off.

Specificity should make the image *easier to generate*, not longer to read. A tight five-rung prompt beats a bloated nine-rung one.

Translate fuzzy adjectives into observable direction. "Professional" is not corporate stock — it's a concrete choice about light, crop, and palette. "Cinematic" is a lighting and contrast decision, not a vibe word.

### Step 3 — Assign reference roles

When references are attached or mentioned, read `references/reference-roles.md` before routing or asking for more. Give each image exactly one role — subject, composition, style, mood, or brand — and use it only for that role.

- Don't invent what a reference doesn't show: no logos, no interface states, no product features, no character traits that aren't visibly present.
- Conflicts with no stated priority resolve in this order: **subject/product fidelity → composition → style → mood**.
- Cap usage at **10 references** even if a model accepts more — most image models top out around there anyway. Fewer, sharper references beat a crowded set; if the user supplies more, drop to the most relevant or ask which to cut.
- Any reference showing an identifiable real person falls under Trust Boundaries — including edits, face transfer, de-aging, and likeness-style transfer. A supplied image is not consent.

If references are needed but not attached, ask for them in your final reply (not via an interactive tool) and route on what you can in the meantime.

### Safety & trust boundaries

The moment a concrete image task touches any of these, read `references/trust-boundaries.md` **before** giving prompt, model, or generation guidance:

> real people · public figures · private persons · minors · paparazzi / candid / surveillance framing · brand logos, packaging, trade dress, mascots · protected characters · named-artist styles · screenshots, dashboards, receipts, IDs, invoices, lab results · before/after "proof" · any evidence-like imagery.

Standing rules:

- **People:** paparazzi, candid, surveillance, or celebrity references need a stated benign, authorized use. Don't identify people, infer private context, research their movements, or optimize for a realistic candid look. Offer non-identifiable style/mood guidance or a clearly fictional placeholder instead.
- **Evidence:** never produce realistic proof — IDs, documents, screenshots, before/after claims. Convert to a clearly fictional, visibly labeled illustrative artifact, or decline.
- **Brands:** third-party logos, packaging, mascots, trade dress, endorsement framing, and co-branded lockups require supplied assets plus authorization. Otherwise offer generic or user-owned branding. Style influence is fine; brand replication is not.
- **Characters & artists:** translate protected characters, mascots, and named-artist styles into non-infringing attributes — palette, line, material, lighting, composition. Don't keep the name in the final prompt.
- **Minors:** for real or apparent minors, no sexualized, evidence-like, or harm-adjacent depictions. Benign non-realistic illustration is fine. If age is uncertain, treat as a minor.
- **Clinical claims:** synthetic before/after for medical, cosmetic, weight-loss, fitness, hair, skin, or supplement results must be clearly labeled illustrative or declined.

### Anti-slop pass

Before finalizing, swap every generic quality word for observable direction — subject placement, focal hierarchy, lighting, material behavior, palette, crop, background quietness, and the one constraint that prevents the likely failure.

Steer away from default model artifacts: vague cinematic glow, floating particles, plastic skin, meaningless bokeh, teal-and-orange grading, generic "futuristic" panels, illegible pseudo-text, overstuffed negative prompts. Each avoid item names an *aesthetic* failure — not a content category (those belong to Trust Boundaries).

### Output

Use the smallest format that satisfies the ask.

Single prompt:

```md
## Prompt
[Final prompt]

## Avoid
[Only the likely failure constraints]

## Capability
[The capability class + one-line reason — include when routing or generating; omit for prompt-only asks with no model question]
```

For reference-based work, add a short `Reference Use` line before the prompt.

For multiple directions, read `references/variant-sets.md`. For mixed crops, transparency, or mixed reference roles, give per-variant capability + framing notes instead of one shared line.

When generating, hand the capability and prompt to the `replicate` skill using its supported parameters. Don't stop at a prompt when generation was requested; don't generate when only a prompt or capability recommendation was asked for.

### Pre-flight checklist

- [ ] Subject, style, and intent preserved.
- [ ] Capability stated + supported framing/transparency requested.
- [ ] No invented evidence, no unauthorized branding.
- [ ] No unconsented real-person or minor use.
- [ ] No false factual or clinical claim.
- [ ] Anti-slop pass done.
- [ ] For 3+ / multi-crop / transparency / brand / person work: plan shown before generating.
