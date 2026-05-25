# Informational Website Design

Build distinctive, content-first websites -- personal sites, portfolios, editorial publications, small business pages, blogs, and landing pages.

**Mandatory shared files (read if not already loaded):** `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md`, `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/02-typography.md`.

---

### Art Direction by Site Type

| Site Type | Concept-Driven Direction | Token Starting Points |
|---|---|---|
| **Personal portfolio** | A fashion photographer's portfolio is moody and image-forward. An architect's is precise and grid-structured. A musician's site is rhythmic and warm. The person's work determines the visual language. | Display font matching the creator's personality. Custom accent derived from their work. Neutral surfaces that don't compete with content. |
| **Editorial / blog** | A literary magazine is typographic and spacious. A tech blog is clean and dense. A food blog is warm and sensory. The editorial voice shapes typography, spacing, and color. | Serif + sans-serif pairing. Body at `--text-base` (16px), line height 1.6-1.7. Accent matching editorial tone. |
| **Small business** | A bakery is warm and inviting. A consulting firm is authoritative and minimal. A yoga studio is calm and organic. The business's character sets the palette and typography. | Font and palette from the business's personality. Strong CTA contrast for conversion. |
| **Landing page** | A developer tool page is technical and precise. A wellness product is soft and aspirational. A creative agency is bold and distinctive. | ONE hero moment (`--text-2xl`+); all other text compact. Accent from the product's brand. |

See `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` for size floors and color restraint rules.

---

## What Makes a Great Informational Website

### 1. Content Hierarchy is the Design

- Keep primary navigation to 5-7 items maximum
- Use progressive disclosure -- essential first, depth on demand
- Every page answers: "Where am I? What can I find here? Where can I go next?"

### 2. Typography Carries the Voice

- **Editorial sites**: Serif headings + sans-serif body is the classic pairing.
- **Personal sites/portfolios**: Refined display font at hero scale for personality. Body font should be invisible. UI text (nav, buttons, labels) at 14px, 12-13px.
- **Small business**: Clean sans-serif signals professionalism. Plus Jakarta Sans, Work Sans, or Inter with a display font for the hero.
- **Blogs**: Source Serif 4 or Lora for long-form body at 16-18px. Line height 1.6-1.7. Max-width 65ch.

**Informational Site Type Scale** — use these token assignments to avoid text that feels too large:

| Element | Token | Resolves to | Notes |
|---|---|---|---|
| Hero heading (ONE per page) | `--text-2xl` to `--text-hero` | 32-128px | Display font. Hero section only — dramatic type is encouraged here. Interior pages cap at `--text-2xl`. |
| Page/section title | `--text-xl` | 24-36px | Display font or body bold. One per section max. |
| Subsection heading | `--text-lg` | 18-24px | Body font, bold. Don't oversize — this should feel like a comfortable step above body. |
| Body copy | `--text-base` | 16-18px | **The standard.** Not `--text-lg`. 16px is the baseline for comfortable reading. |
| Nav links, buttons | `--text-sm` | 14-16px | Smaller than body. UI chrome should recede. |
| Metadata, captions, labels | `--text-xs` | 12-14px | Dates, read times, categories, footer text. |

**Common mistake: using `--text-lg` for body copy.** This makes everything feel oversized and reduces content density. Body text is `--text-base` (16px). `--text-lg` is for subsection headings only. If the page feels like text is too large, audit for this pattern.

### 3. White Space is Confidence

- Generous section padding: `clamp(var(--space-12), 8vw, var(--space-32))`
- Let hero sections breathe -- 60-80vh minimum height with centered content
- Don't fill every gap with a CTA or decorative element

### 4. Rich Visual Content

- **Generate images — don't leave pages text-only.** Use the image generation tool to create hero images, section illustrations, background textures, and editorial photography that match the site's art direction. A well-art-directed generated image beats a blank section or generic placeholder every time.
- **Full-bleed image moments.** Break the content grid with 1-2 full-width images per page — a dramatic hero, a mid-page visual divider, or an image that bleeds to the edge while text stays contained. These moments create rhythm and visual richness.
- **Content images must be real.** URLs for photos/videos must come from actual search results, not hallucinated. When real images aren't available, generate custom ones rather than leaving gaps.

### 5. Multi-Column Editorial Layouts

Informational sites should feel editorially rich, not like a single-column blog post. Use grid-based layouts inspired by magazine and editorial design:

- **Asymmetric two-column.** Text on one side, image or pull quote on the other. Vary which side the image appears on between sections.
- **Feature grid.** A large hero card spanning 2 columns + 2-3 smaller cards below. Great for portfolios, featured content, and blog indexes.
- **Full-bleed + inset.** Full-width image → narrow text container → full-width image. The width changes create visual rhythm.
- **Sidebar + main.** Table of contents or metadata sidebar alongside long-form content. Sidebar sticks on scroll.
- **Pull quotes and callout blocks** that span wider than body text (or break into the margin) to create typographic variety and draw attention to key ideas.
- **Photo grids for visual storytelling.** CSS Grid with varying `span` values: one large hero image (2×2) alongside 2-3 smaller supporting images creates a magazine-spread feel.
- **Masonry for variable-height content.** Image galleries, portfolios, or mixed-media collections. Use CSS columns or JS Masonry.

On mobile, all multi-column layouts collapse to a single column — but maintain visual rhythm by keeping full-bleed images and pull quotes as section dividers. See `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/04-layout.md` for grid implementation.

### 6. Distinctive Visual Identity

- **Find the one memorable choice.** An elegant font. A restrained color accent. An asymmetric layout moment. One refined element > ten loud ones.
- **Restraint IS the identity.** Personality comes from typography and spacing, not color or effects. (AI aesthetic anti-patterns in `08-standards.md`.)

### 7. Performance is Respect

- Target LCP < 1.5s
- Total page weight under 800KB initial load
- Defer all non-critical JavaScript
- Responsive images with `srcset` and modern formats (WebP/AVIF)
- Preload hero image and critical fonts

---

## Best Practices by Site Type

### Personal Sites & Portfolios

- **Lead with work, not biography.** Best 3-5 pieces above the fold.
- **Case studies > thumbnails.** One well-presented project with context, process, outcome > grid of 20 thumbnails.
- **Minimal navigation.** Work, About, Contact. Maybe a blog.
- **Contact should be effortless.** Email link, not a 12-field form.
- **Show personality.** The design itself is a portfolio piece.

### Editorial & Blog Sites

- **Reading experience is everything.** Body at `--text-base` (16px), line-height 1.6-1.7, max-width 65ch for prose.
- **Clear article hierarchy.** Date, author, read time, category -- visible but not dominant.
- **Rich media integration.** Pull quotes, full-bleed generated images, embedded video, code blocks — these create visual rhythm and prevent wall-of-text fatigue. Aim for a visual moment every 2-3 scroll heights.
- **Multi-column article layouts.** Long-form articles benefit from editorial composition: a wide hero, then prose with a sidebar, then a full-bleed image, then a two-column comparison. Reference: NYT, Stripe Press, It's Nice That. Don't just stack paragraphs — design the reading journey.
- **Magazine-style index pages.** Feature grids (large hero card + smaller cards), asymmetric layouts, and image-forward cards for article listings. Not just a flat chronological list.
- **Related content.** 2-3 related pieces at end of every article.
- **Search and archives.** Well-organized with categories, tags, and search.

### Small Business Sites

- **Answer the core question immediately.** "What does this business do, and why should I care?" in the first viewport.
- **Social proof early.** Testimonials, client logos, ratings within first 2 scrolls.
- **One primary CTA per page.** "Book a call", "Get a quote" -- pick one and make it unmissable.
- **Local business: prioritize practical info.** Hours, location, phone, directions immediately findable.
- **Mobile-first.** 60%+ of small business traffic is mobile.

---

## SEO & Discoverability

- **Semantic HTML** (`<nav>`, `<main>`, `<article>`, `<section>`, `<footer>`)
- **One `<h1>` per page** clearly describing the page's purpose
- **Heading hierarchy** (`h1` > `h2` > `h3`) -- never skip levels, never use headings for styling
- **Meta descriptions** -- 150-160 characters for every page
- **Open Graph tags** -- `og:title`, `og:description`, `og:image`
- **Structured data** (JSON-LD) -- schema.org for articles, businesses, people, events
- **Alt text on every image** -- descriptive, specific, not keyword-stuffed
- **Core Web Vitals** -- fast sites rank higher
- **XML sitemap** for crawlability

---

## Accessibility

Beyond baseline in `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/08-standards.md`:

- **Reading order must match visual order.** Screen readers follow the DOM, not CSS layout.
- **Language attribute** — `<html lang="en">` (or appropriate language).
- **Descriptive link text.** "Read the full case study" not "Click here" or "Read more".
- **Video captions and transcripts.** All video needs captions; audio needs transcripts.

---

## Scroll & Navigation Patterns

### Sticky Header with Scroll-Aware Behavior
```css
.header {
  position: sticky;
  top: 0;
  z-index: 50;
  background: oklch(from var(--color-bg) l c h / 0.9);
  backdrop-filter: blur(12px);
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              box-shadow 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.header--hidden {
  transform: translateY(-100%);
}
.header--scrolled {
  box-shadow: var(--shadow-sm);
}
```

---

## Expert Intake

**Infer first, ask second.** Before asking the user about style, derive art direction from the subject matter using the Art Direction table above. A photography portfolio → moody, image-forward. A bakery → warm, inviting. A law firm → sober, minimal. Most sites give strong signals through their content alone.

If the subject is genuinely ambiguous, ask: site type? audience? primary action? tone? brand assets? reference sites?

**Default (minimal input):** Even with minimal input, **infer art direction from the subject.** A photographer's portfolio gets moody tones and a refined serif. A bakery gets warm earth tones and a friendly rounded sans. A tech startup gets cool neutrals and a geometric sans. Derive font and color choices from the content — see `shared/02-typography.md` → "Font Pairing by Concept" for starting points. Only fall back to Kortix palette + Satoshi/General Sans when the request is truly generic with no topic to infer from.

**Key shared files:** `shared/03-motion.md` (scroll effects, GSAP SVG), `shared/07-toolkit.md` (SVG patterns/filters).
