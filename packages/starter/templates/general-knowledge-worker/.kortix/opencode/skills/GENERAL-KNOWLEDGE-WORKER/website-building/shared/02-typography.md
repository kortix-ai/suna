# Typography (Web-Specific)

For universal typography principles (Bringhurst foundations, economy of styles, display vs. body classification, serif vs. sans-serif strategy, brand fonts, font blacklist, and recommended pairings), see `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md`.

This file adds **web-specific** rules that extend those foundations with CSS tokens and implementation details.

**This guidance applies to ALL web project types** — informational sites, web applications (including the fullstack webapp template), and games. For webapp/Tailwind projects, the CSS custom properties (`--text-xl`, `--font-display`) map to Tailwind equivalents (`text-xl`, `font-sans`). The design *rules* (font selection, display vs. body territory, size hierarchy, blacklist) are universal regardless of implementation.

---

## Intentional Font Selection

**Font choice is a design decision, not a default.** Every website's fonts should be intentionally selected to match the art direction — a jazz festival gets a different typeface than a SaaS dashboard. Don't just reach for Inter or DM Sans every time; let the concept guide the pairing.

**Always infer font direction from the content.** Before selecting fonts, ask: what is the subject, tone, and audience? A legal firm needs authoritative serifs. A children's education app needs friendly rounded sans. A fashion brand needs high-contrast editorial type. The concept should narrow the font choice — never pick fonts in a vacuum.

### Font Pairing by Concept

Use this table as a starting point — vary based on the specific project. **Every project should feel different.** Avoid repeating the same pairing across unrelated sites.

| Concept / Tone | Display Font (headings) | Body Font | Source |
|---|---|---|---|
| **Warm / editorial / literary** | Boska, Zodiak, Erode | Source Serif 4, Lora | Fontshare + Google |
| **Clean / modern / tech** | Cabinet Grotesk, General Sans | Satoshi, Inter | Fontshare |
| **Luxury / fashion / refined** | Instrument Serif, Cormorant | Switzer, Work Sans | Google + Fontshare |
| **Friendly / playful / education** | Chillax, Plus Jakarta Sans | Nunito, General Sans | Fontshare + Google |
| **Bold / creative / agency** | Clash Display, Clash Grotesk | Satoshi, General Sans | Fontshare |
| **Authoritative / corporate / legal** | Playfair Display, DM Serif Display | DM Sans, Source Sans 3 | Google |
| **Technical / developer / data** | JetBrains Mono, Geist Mono | Geist, Inter | Google |
| **Organic / wellness / nature** | Zodiak, Erode | Work Sans, Nunito | Fontshare + Google |
| **Retro / vintage / nostalgic** | Boska, Gambetta | Switzer, Archivo | Fontshare + Google |
| **Minimal / Swiss / precise** | Switzer, Satoshi | Satoshi, General Sans | Fontshare |

**If nothing above fits, browse Fontshare's catalog** — it has 100+ curated families. The table is a starting point, not an exhaustive list. The goal is **variety across projects**: two different bakery sites should not use the same fonts.

**Prefer Fontshare over Google Fonts.** Fontshare fonts are less overexposed and more distinctive. Google Fonts (Roboto, Open Sans, Lato, Montserrat, Poppins) are so widely used they've become invisible. Fontshare alternatives (Satoshi, General Sans, Cabinet Grotesk, Boska, Zodiak) give websites an immediately more refined feel. Use Google Fonts only when Fontshare doesn't have what you need.

**System fonts are fallback only.** Never use Arial, Helvetica, Georgia, Calibri, Times New Roman, Verdana, Tahoma, or Trebuchet MS as the primary chosen font for a website. They exist only as fallback in the `font-family` stack — the browser uses them if the real font fails to load. The font-family declaration should always be: `'Chosen Font', 'system-fallback', sans-serif`.

See `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md` → Font Strategy by Format for why websites differ from slides/documents.

---

## Display vs. Body — CSS Token Mapping

| Font type | Minimum size | Tokens |
|---|---|---|
| **Display font** | 24px | `--text-xl` and above only |
| **Body font** | 12px | `--text-xs` through `--text-base` |
| **Body font (bold, as heading)** | 18px | `--text-lg` through `--text-xl` |

- Label which is which in CSS: `--font-display` and `--font-body`.
- Condensed, compressed, narrow, extended, high-contrast, decorative fonts: display sizes only (24px+).
- Body text (16-18px): even proportions, generous x-height (Satoshi, General Sans, Inter, DM Sans, Work Sans, Source Serif 4).
- Small text (12-14px): large x-height, open counters. Sans-serif preferred. 12px absolute floor.

```
DISPLAY FONT TERRITORY (--font-display only):
  --text-hero / --text-3xl → Informational sites ONLY (editorial heroes, portfolio splash, landing headlines).
                             Never in web apps, dashboards, or admin panels.
  --text-2xl               → Display font. Informational/landing hero ONLY. Never in web apps.
  --text-xl                → Display font or bold body font. MAX heading size in web apps.

BODY FONT TERRITORY (--font-body only):
  --text-lg                → Body font, bold or semibold for headings. 18-24px.
  --text-base              → Body font, regular weight. 16px. Standard for body copy.
  --text-sm                → Body font, regular weight. 14px. Buttons and UI chrome.
  --text-xs                → Body font, regular or medium weight. 12px floor. Tiny labels only.
```

See `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` for the canonical size table and "Max Display Size by Site Type".

**Self-check**: Count distinct type styles on the page (unique combinations of font, size, weight, color). If more than 4-5, audit ruthlessly.

---

## Too Experimental / Polarizing (Web-Specific)

Avoid these — too niche, polarizing, or easy to misuse for general web design:
Syne, Savate, Special Gothic Expanded One, Anybody, Climate Crisis, Unbounded, Red Rose, Space Grotesk, Pally (Fontshare), Comico (Fontshare).

---

## Font Sources

Two primary free font services. **Always check Fontshare first** — its catalog is curated, less overexposed, and immediately more distinctive than Google Fonts. Only go to Google Fonts when Fontshare doesn't have what you need. Both are free for commercial use; you can mix them (e.g., Fontshare display + Google Fonts body).

---

## Loading Fonts

### Fontshare (Preferred)

```html
<!-- Fontshare — use api.fontshare.com CDN -->
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,700&f[]=boska@400,500,700&display=swap" rel="stylesheet">
```

- Use `v2` API: `https://api.fontshare.com/v2/css`
- Fonts: `f[]=font-name@weights` (lowercase, hyphenated: `general-sans`, `cabinet-grotesk`, `zodiak`)
- Always add `display=swap`
- Provide CSS fallback: `font-family: 'Satoshi', 'Inter', sans-serif;`

### Google Fonts

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Work+Sans:wght@300..700&display=swap" rel="stylesheet">
```

- Always `display=swap`
- Use variable font axis ranges (`wght@300..700`) instead of individual weights
- Always add `preconnect` to both domains before the stylesheet

### Mixing Sources

```html
<!-- Fontshare font for headings -->
<link href="https://api.fontshare.com/v2/css?f[]=boska@400,500,700&display=swap" rel="stylesheet">

<!-- Google Font for body (preconnect first) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Work+Sans:wght@300..700&display=swap" rel="stylesheet">
```

### General Rules

- 2-3 font families maximum per project
- Provide CSS fallback stacks: `font-family: 'Boska', 'Georgia', serif;` — the system font is the fallback, never the primary (see "Intentional Font Selection" above)
- Never load more weights than you use

### Variable Font Power Features
```css
h1 { font-weight: 750; }  /* Between Bold and ExtraBold */
h2 { font-variation-settings: 'wght' 620, 'wdth' 90; }
h1 { font-weight: clamp(500, 40vw, 900); }  /* Fluid weight */
```
