# Reference Image Roles

Read this when the user attaches or mentions reference images. Give each image one role and use it only for that role — never stretch a reference into a role the user didn't imply.

## Roles

| Role | Take from it | Don't infer from it |
|---|---|---|
| Subject | identity, shape, product details, pose, visible attributes | unseen features, brand claims, hidden text |
| Composition | framing, camera angle, scale, negative space, layout | subject identity or style |
| Style | palette, material, lighting, render language, texture | exact artwork, protected characters, exact composition |
| Mood | emotional tone, energy, atmosphere | specific objects or factual claims |
| Brand | supplied logo, colors, type, product rules | missing logos, partner marks, campaign claims |

## When references conflict

Honor the priority the user states. With none stated, resolve in this order:

1. Subject / product fidelity
2. Composition
3. Style
4. Mood

Mention the reference use briefly only when it helps the user read the output.

## Provenance and safety

- User-owned products or assets: preserve only the requested visible features.
- Third-party brand references: use broad art direction unless the user supplies exact assets and asks for brand-consistent work.
- Real logos and marks: never invent, approximate, or hallucinate one. Preserve a supplied mark, or use fictional placeholder branding.
- Real-person likeness: avoid deceptive, compromising, sexual, political, medical, criminal, or evidentiary contexts. When unsure, keep it clearly fictional or ask.
- Any identifiable real person triggers the Trust Boundaries in `trust-boundaries.md` — including edits, face transfer, de-aging, and likeness-style transfer. A supplied image is not consent.

## Cap

Use at most 10 references even when the model accepts more — and the `media` `images` parameter caps at 10 regardless. Fewer, more relevant references generate better than a crowded set. If the user supplies more, narrow to the strongest or ask which to drop.
