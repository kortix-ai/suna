# Toolkit — Libraries for World-Class Interfaces

**Two environments, one standard:**
- **Vanilla HTML/CSS/JS** (default) — CDN scripts and import maps. No npm, no build step.
- **React projects** — npm/esm.sh imports. shadcn/ui patterns and companion libraries (Sonner, Vaul, cmdk, TanStack Table, React Hook Form + Zod) in `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/06-css-and-tailwind.md`.

Animation libraries (Motion, GSAP, Lenis) are covered in `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/03-motion.md`. Chart libraries (Chart.js, Recharts, D3, Nivo, etc.) are covered in `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/10-charts-and-dataviz.md`.

---

## Available in Any Project (CDN)

| Library | What it does | When to reach for it |
|---|---|---|
| [Lucide](https://lucide.dev) | 1,500+ clean SVG icons. 24px grid, 2px stroke. | Every project that needs icons. The default icon library. |
| [Phosphor](https://phosphoricons.com) | 9,000+ icons in 6 weights (web font). | Alternative when you need more weight variants (thin, light, bold, fill, duotone). |
| [Embla Carousel](https://www.embla-carousel.com) | Performant, dependency-free carousel. Library-agnostic. | Any carousel, slider, or swipeable content. |
| [Splitting.js](https://splitting.js.org) | Wraps each character/word in its own `<span>` for per-letter animation. | Hero text reveals, staggered character animations, glitch text, rolling titles. |
| [Rough Notation](https://roughnotation.com) | Hand-drawn annotation animations — circles, underlines, highlights, brackets. | Text callouts, landing page emphasis, educational content. Makes text feel human. |

---

## Micro-Interaction Libraries (npm or esm.sh)

| Library | Purpose |
|---|---|
| [NumberFlow](https://number-flow.barvian.me) | Animated number transitions — digits spin individually. Prices, stats, KPIs. |
| [torph](https://torph.lochie.me/) | Text morphing — shared-letter transitions. Button labels, status text. |

**Component inspiration** (copy-paste, not packages): [Magic UI](https://magicui.design) (150+ animated components), [Motion Primitives](https://motion-primitives.com) (composable motion). Copy and adapt — you own the code.

---

## CDN Setup — Vanilla HTML

**Lucide Icons** (default — inline SVG approach):
```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
<i data-lucide="search"></i>
<i data-lucide="settings"></i>
<script>lucide.createIcons();</script>
```

**Phosphor Icons** (web font — load only the weights you need):
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@phosphor-icons/web@2.1.2/src/regular/style.css" />
<i class="ph ph-magnifying-glass"></i>
<i class="ph ph-gear"></i>
```
Other weights: replace `regular` and `ph` with `bold`/`ph-bold`, `light`/`ph-light`, `thin`/`ph-thin`, `fill`/`ph-fill`, or `duotone`/`ph-duotone`.

**Splitting.js** (character/word animation):
```html
<link rel="stylesheet" href="https://unpkg.com/splitting/dist/splitting.css" />
<link rel="stylesheet" href="https://unpkg.com/splitting/dist/splitting-cells.css" />
<script src="https://unpkg.com/splitting/dist/splitting.min.js"></script>

<h1 data-splitting>Award-winning typography</h1>
<script>Splitting();</script>

<style>
  /* Staggered reveal — each character gets --char-index */
  .splitting .char {
    opacity: 0;
    animation: reveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    animation-delay: calc(var(--char-index) * 40ms);
  }
  @keyframes reveal { to { opacity: 1; } }
</style>
```

**Rough Notation** (hand-drawn annotations):
```html
<script src="https://unpkg.com/rough-notation/lib/rough-notation.iife.js"></script>
<p>We make <span id="highlight">impossible things</span> possible.</p>
<script>
  const annotation = RoughNotation.annotate(
    document.getElementById('highlight'),
    { type: 'highlight', color: 'oklch(0.85 0.15 85)', animate: true }
  );
  annotation.show(); // Types: underline, circle, highlight, strike-through, bracket
</script>
```

---

## esm.sh Setup — React Without a Build Step

For lightweight React projects deployed as static HTML (no Vite, no bundler), use import maps:

```html
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18",
    "react-dom/client": "https://esm.sh/react-dom@18/client",
    "@number-flow/react": "https://esm.sh/@number-flow/react?external=react",
    "torph/react": "https://esm.sh/torph/react?external=react",
    "embla-carousel-react": "https://esm.sh/embla-carousel-react?external=react",
    "recharts": "https://esm.sh/recharts?external=react"
  }
}
</script>
```

Add shadcn companion libraries (Sonner, Vaul, cmdk) to the import map as needed — see `06-css-and-tailwind.md` for when to use them.

---

## Icons

**Always use Lucide (default) or Phosphor** — never generate or draw icons. CDN setup is above.

- Only add icons when they aid comprehension — not for decoration.
- Icon-only buttons need `aria-label` + tooltip. No exceptions.
- All-or-nothing in nav: every item gets an icon or none do.
- Size: 16px inline, 20px buttons/nav, 24px standalone.
- Use `currentColor` so icons inherit text color and respect dark/light mode.

---

## SVG Patterns & Filters

Ready-to-paste `<defs>` for background textures and visual effects. All use `currentColor` for dark/light mode. Apply patterns via `background: url(#id)`, filters via `filter: url(#id)`.

```html
<svg width="0" height="0"><defs>
  <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
    <circle cx="10" cy="10" r="1.5" fill="currentColor" opacity="0.15"/></pattern>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" stroke-width="0.5" opacity="0.1"/></pattern>
  <pattern id="diagonals" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1" opacity="0.08"/></pattern>
  <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/>
    <feColorMatrix type="saturate" values="0"/><feBlend in="SourceGraphic" mode="multiply"/></filter>
  <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/>
    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="shadow"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="oklch(0.2 0.01 80)" flood-opacity="0.12"/></filter>
</defs></svg>
```

---

## Maps & Geospatial

When a project needs a map — never use Google Maps (requires API key and billing):

| Library | Best For | CDN |
|---|---|---|
| **MapLibre GL JS** | Free interactive vector maps (OpenFreeMap tiles), markers, popups. No API key. | `<link href="https://unpkg.com/maplibre-gl@latest/dist/maplibre-gl.css" rel="stylesheet" />` + `<script src="https://unpkg.com/maplibre-gl@latest/dist/maplibre-gl.js"></script>` |
| **Mapbox GL JS** | Premium features: 3D terrain, turn-by-turn, Mapbox Studio styles. Requires API key. | `<script src="https://api.mapbox.com/mapbox-gl-js/v3.12.0/mapbox-gl.js"></script>` |
| **D3.js** | Choropleths, custom projections, data-driven geo viz | `<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>` |

OpenFreeMap style URL: `https://tiles.openfreemap.org/styles/{liberty,bright,positron}`. Do **not** use OpenStreetMap tiles (`tile.openstreetmap.org`) — they require a Referer header and return 403 in sandboxed iframes.

---

## Three.js & 3D (When Appropriate)

Use 3D sparingly — for hero moments, product showcases, or immersive experiences. Covered in detail in `skills/GENERAL-KNOWLEDGE-WORKER/website-building/game/game.md`.

**CDN Setup:**
```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.183.0/examples/jsm/"
  }
}
</script>
<script type="module">
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
</script>
```

Target under 100 draw calls. `InstancedMesh` for repeated objects. Compress geometry (Draco) and textures (KTX2/basis). Cap pixel ratio: `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`. Lazy-load 3D below the fold.
