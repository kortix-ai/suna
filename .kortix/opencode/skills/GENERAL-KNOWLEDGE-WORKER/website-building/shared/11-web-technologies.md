# Web Technologies — Browser Support & Emerging Standards (2026)

Library-specific details live in their dedicated files:
- Animation: `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/03-motion.md`
- CSS & Tailwind: `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/06-css-and-tailwind.md`
- Toolkit & CDN setup: `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/07-toolkit.md`
- Charts & data viz: `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/10-charts-and-dataviz.md`

This file covers only browser compatibility baselines and emerging web platform features.

---

## Browser Support Baseline (2026)

| Feature | Chrome | Firefox | Safari | Edge |
|---|---|---|---|---|
| CSS Nesting | 120+ | 117+ | 17.2+ | 120+ |
| Container Queries | 105+ | 110+ | 16+ | 105+ |
| `:has()` selector | 105+ | 121+ | 15.4+ | 105+ |
| View Transitions | 111+ | behind flag | 18+ | 111+ |
| Scroll-driven Animations | 115+ | behind flag | no | 115+ |
| `@starting-style` | 117+ | 129+ | 17.5+ | 117+ |
| Popover API | 114+ | 125+ | 17+ | 114+ |
| WebGPU | 113+ | behind flag | 26+ | 113+ |
| `color-mix()` | 111+ | 113+ | 16.2+ | 111+ |
| `@property` | 85+ | 128+ | 15.4+ | 85+ |
| Subgrid | 117+ | 71+ | 16+ | 117+ |
| `content-visibility` | 85+ | 125+ | 18+ | 85+ |

**Rule:** Features with 90%+ global support can be used freely. Features below 90% need `@supports` fallbacks.

---

## Emerging Technologies (Watch List)

| Technology | Status | What it enables |
|---|---|---|
| **WebGPU** | Shipping in Chrome, Safari 26+. Firefox behind flag. | GPU compute, next-gen 3D rendering, ML inference in browser |
| **CSS `contrast-color()`** | Interop 2026. Safari first. | Auto-accessible text color on any background |
| **CSS `sibling-index()`** | Early implementation | CSS-only staggered animations without JS |
| **Advanced `attr()` typing** | Chrome 133+ | Data attributes as CSS values (colors, numbers, lengths) |
| **CSS `shape()` function** | Chrome/Edge | Responsive clip-paths with %, vw, calc() (not just px) |
| **Speculation Rules API** | Chrome 121+ | Instant page loads via prerendering |
| **Shared Element Transitions (MPA)** | Experimental | Cross-page morphing animations |
| **CSS Anchor Positioning** | Chrome 125+ | Position tooltips/dropdowns relative to triggers, no JS |
