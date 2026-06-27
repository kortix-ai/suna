# Symbol Generation Prompt Patterns

Proven prompt formulas for generating logo symbols with the `replicate` skill (Flux Schnell).

**IMPORTANT:** Only use AI for symbols/icons. All text rendering (wordmarks, combination marks) is handled by `compose_logo.py` using real Google Fonts. Never ask the AI to render text.

---

## Universal Anchors (include in EVERY symbol prompt)

```
on a solid pure white (#FFFFFF) background, centered composition, isolated design,
clean vector style, professional logo design, high contrast,
simple and scalable, no text, no letters, no words, no writing,
flat colors only, no gradients, no glow, no shadows, no 3D, no photorealism
```

Why each matters:
- **solid pure white background** — clean extraction for `remove_bg`, clean composition
- **centered composition** — keeps subject in frame
- **isolated design** — prevents scene generation
- **clean vector style** — flat, print-ready aesthetics
- **no text/letters/words/writing** — models love adding random text. Block it aggressively.
- **flat colors only** — prevents gradients and effects that don't scale

---

## Logomark (Symbol / Icon) — The Primary Prompt

```
A [STYLE] logomark symbol for a [INDUSTRY] brand.
The symbol represents [CONCEPT/METAPHOR].
[COLOR INSTRUCTION].
On a solid pure white (#FFFFFF) background, centered composition, isolated design,
clean vector style, professional logo design, high contrast,
simple geometric shapes, minimal detail, scalable icon,
no text, no letters, no words, no writing,
flat colors only, no gradients, no glow, no shadows.
```

### Style Modifiers (pick one)

- `minimalist flat` — fewest shapes, strongest silhouette
- `geometric abstract` — interlocking shapes, mathematical feel
- `organic flowing` — curves, natural forms, movement
- `bold and solid` — thick lines, heavy fills, high impact
- `line art` — single-weight strokes, no fills
- `negative space` — clever use of background as part of the design

### Lettermark Variant (for monogram symbols)

```
A [STYLE] lettermark monogram symbol using the letters "[INITIALS]".
[COLOR INSTRUCTION].
On a solid pure white (#FFFFFF) background, centered composition, isolated design,
clean vector style, professional monogram design,
the letters "[INITIALS]" are stylized and interlocking,
bold and readable, no additional imagery, no icons beyond the letters.
```

---

## Color Instructions

Always start with black. Add color in refinement rounds.

**Monochrome (round 1 — always start here):**
```
Using only black (#000000). Monochrome design.
```

**Single brand color (round 2+):**
```
Using [COLOR NAME] (#HEX) as the primary color with white negative space.
```

**Two-tone (round 2+):**
```
Using [COLOR1] (#HEX1) and [COLOR2] (#HEX2) only. Two-color palette, no gradients.
```

---

## Style Boosters

### Tech / Startup
```
modern, geometric, precise edges, silicon valley aesthetic, forward-looking
```

### Luxury / Premium
```
refined, sophisticated, understated elegance, thin precise lines, generous whitespace
```

### Playful / Consumer
```
friendly, approachable, rounded shapes, warm personality, slightly whimsical
```

### Bold / Athletic
```
powerful, dynamic, strong angles, heavy weight, commanding presence, energetic
```

### Organic / Natural
```
flowing curves, natural forms, earthy, hand-crafted feel, growth metaphor
```

---

## Common Failures & Fixes

| Problem | Fix |
|---|---|
| Random text in image | Add `no text, no letters, no words, no writing, no characters` |
| Too complex | Strip adjectives, add `extreme simplicity, fewest possible shapes` |
| Not centered | Add `centered on canvas, isolated, nothing else in frame` |
| Photorealistic | Add `flat vector illustration style, no 3D, no photorealism, no rendering` |
| Gradient/glow effects | Add `flat colors only, no gradients, no glow, no shadows, no effects` |
| Too much detail | Add `minimal detail, simple shapes only, works at 32x32 pixels` |
| Background not white | Use `on a pure white (#FFFFFF) background, nothing else visible` |

---

## Generation Strategy

1. **Start monochrome.** If the shape works in B&W, it works everywhere.
2. **Vary the metaphor, not just the style.** "Shield" vs "arrow" vs "abstract wave" are more different than "minimalist shield" vs "geometric shield."
3. **Generate 4-6 per round.** Not 1 at a time, not 20.
4. **Name files descriptively.** `logomark-hexagon-growth.webp` not `image-01.webp`.
5. **Always remove_bg** on symbols you plan to compose — transparent PNGs compose cleanly.
6. **Curate to 3-5 strong options.** Don't show everything.
