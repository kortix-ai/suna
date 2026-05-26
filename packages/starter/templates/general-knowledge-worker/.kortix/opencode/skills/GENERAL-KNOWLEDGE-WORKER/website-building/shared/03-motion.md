# Motion & Animation

Treat your interface as a physical space with unbreakable rules. Every element moves *from* somewhere *to* somewhere. Nothing just appears or disappears.

**Priority order:** Simplicity → Fluidity → Delight. You cannot polish a bad layout with animations.

**The Delight-Impact Curve:** The less frequently a feature is used, the more delightful it should be. Daily actions need efficiency with subtle touches. Rare moments deserve theatrical ones.

---

## CSS-Native Animation (Preferred for HTML/JS projects)

### Scroll-Driven Animations (CSS-only, replaces AOS/ScrollReveal)

**CRITICAL: Scroll reveals must NOT cause layout shift (CLS).** The animated element must occupy its final layout space from the start. Only animate visual properties (`opacity`, `clip-path`, `filter`) — never `transform: translateY()` on scroll-triggered elements, because the element visually occupies a different position during the animation while pushing content around.

```css
/* GOOD — opacity-only reveal. Element takes up its final space immediately. */
.fade-in {
  opacity: 1; /* Fallback: visible by default */
}

@supports (animation-timeline: scroll()) {
  .fade-in {
    opacity: 0;
    animation: reveal-fade linear both;  /* linear maps 1:1 to scroll progress — correct for scroll-driven */
    animation-timeline: view();
    animation-range: entry 0% entry 100%;
  }
}

@keyframes reveal-fade {
  to { opacity: 1; }
}

/* GOOD — clip-path reveal. Element is in place, just visually masked. */
.reveal-up {
  opacity: 1;
}

@supports (animation-timeline: scroll()) {
  .reveal-up {
    clip-path: inset(100% 0 0 0);  /* Masked from bottom — no layout shift */
    animation: reveal-clip linear both;
    animation-timeline: view();
    animation-range: entry 0% entry 100%;
  }
}

@keyframes reveal-clip {
  to { clip-path: inset(0 0 0 0); }
}
```

### @starting-style for Enter Animations (no JS)
```css
dialog[open] {
  opacity: 1; transform: scale(1);
  transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1),
              transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);

  @starting-style {
    opacity: 0; transform: scale(0.95);
  }
}
```

### CSS View Transitions for Page/Route Changes
```css
@view-transition { navigation: auto; }
::view-transition-old(root) { animation: fade-out 0.2s cubic-bezier(0.4, 0, 1, 1); }  /* exit curve */
::view-transition-new(root) { animation: fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1); }  /* golden curve */
```

### @property for Animatable Custom Properties
```css
@property --gradient-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}
.gradient-border {
  --gradient-angle: 0deg;
  border-image: linear-gradient(var(--gradient-angle), var(--color-primary), var(--color-blue)) 1;
  animation: spin 3s linear infinite;  /* linear is correct for continuous rotation */
}
@keyframes spin { to { --gradient-angle: 360deg; } }
```

---

## Motion Library (for React projects)

When building with React, use the **Motion** library (formerly framer-motion — same package, renamed) for physics-based spring animations, exit animations, and layout transitions.

**CDN for vanilla JS** (non-React projects):
```html
<script src="https://cdn.jsdelivr.net/npm/motion@latest/dist/motion.js"></script>
```

Spring presets and duration-based alternatives are in the **Easing & Timing Reference** section above.

### Key Patterns

```jsx
// AnimatePresence for exit animations
<AnimatePresence mode="wait">
  <motion.div
    key={currentView}
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -20 }}
    transition={{ type: "spring", damping: 25, stiffness: 200 }}
  />
</AnimatePresence>

// Shared element transitions with layoutId
<motion.div layoutId={`card-${id}`} transition={{ type: "spring", damping: 30, stiffness: 200 }} />

// Staggered reveals with variants
// NOTE: Use opacity-only for scroll-triggered reveals to avoid CLS.
// translateY is acceptable here because AnimatePresence controls when
// elements mount — they aren't shifting existing content.
const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.1 } }
};
const item = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { type: "spring", damping: 25, stiffness: 200 } }
};

<motion.ul variants={container} initial="hidden" animate="show">
  {items.map(i => <motion.li key={i} variants={item} />)}
</motion.ul>
```

---

## Easing & Timing Reference

Easing is the single most important lever for how animations *feel*. Perceived speed matters more than actual duration — the right curve makes an interface feel responsive even at identical millisecond counts. A bad curve makes everything feel sluggish.

### The Easing Blueprint

**Choose easing by what the element is doing:**

| Easing type | Curve | When to use | Why |
|---|---|---|---|
| **ease-out** (primary) | `cubic-bezier(0.16, 1, 0.3, 1)` | Entries, reveals, user-initiated actions (open modal, show dropdown, button press feedback) | Fast start → gentle settle. Feels immediately responsive because peak velocity is at the beginning. This is the **default for almost everything**. |
| **ease-in-out** | `cubic-bezier(0.4, 0, 0.2, 1)` | Elements already on-screen that morph or move to a new position (resize, reorder, layout shift, carousel slide) | Smooth acceleration and deceleration. Matches natural physical movement — like a car pulling away and coasting to a stop. |
| **ease-in** | `cubic-bezier(0.4, 0, 1, 1)` | **Exit animations only.** Elements leaving the screen. | Slow start → fast finish. Creates the feeling of an element accelerating away. **Never use for entries** — the slow start feels unresponsive and sluggish. |
| **linear** | `linear` | Scroll-driven timelines, continuous rotation, progress bars, marquees, hold-to-delete timers | Constant speed maps to passage of time. Correct when the animation represents a linear process. **Never for UI transitions** — feels robotic. |
| **ease** (CSS default) | `ease` | Color/opacity transitions on hover where subtlety matters more than energy (link underlines, background tints) | Asymmetric — slightly faster start than ease-in-out. Elegant for micro-transitions. |
| **spring** | `damping: 30, stiffness: 200` | React projects via Motion library. Layout transitions, shared element morphs, interactive drag-and-release. | Physics-based — no fixed duration. Feels alive. Preferred over cubic-bezier in React when possible. |

### Duration Quick-Reference

All durations assume the golden ease-out curve unless noted otherwise.

| Context | Duration | Easing | Notes |
|---|---|---|---|
| Hover / focus / active | **180ms** | ease-out | `--transition-interactive` system constant. Fast enough to feel instant, slow enough to perceive. |
| Tooltip / popover appear | **150-200ms** | ease-out | Shorter than modals — tooltips should feel snappy. |
| Button press (`:active`) | **100-150ms** | ease-out | Add `scale(0.97)` or `translateY(1px)` for tactile feedback. |
| Modal / dialog enter | **300ms** | ease-out | `opacity` + `scale(0.95→1)` or `translateY(20→0)`. |
| Modal / dialog exit | **200ms** | ease-in | Exits are always faster than entries. |
| Dropdown / sheet enter | **250-300ms** | ease-out | Slide from edge + fade. |
| Dropdown / sheet exit | **200ms** | ease-in | Reverse direction of entry. |
| Page / route transition | **300ms** | ease-out (in), ease-in (out) | Old page: 200ms ease-in fade-out. New page: 300ms ease-out fade-in. |
| Layout morph (resize, reorder) | **350-500ms** | ease-in-out | Element is already visible — smooth acceleration + deceleration. |
| Number count-up | **400-800ms** | ease-out | Longer durations for larger value deltas. Use NumberFlow or CSS `@property`. |
| Chart entry (bars, lines, arcs) | **600-800ms** | ease-out | Bars grow from baseline, lines draw left-to-right, arcs sweep. |
| Skeleton shimmer | **1.5s** | ease-in-out | `infinite` loop. Gentle oscillation, not jarring. |
| Stagger delay per item | **40-60ms** | — | Applied as `animation-delay` or `staggerChildren`. Keep total stagger under 400ms. |
| Scroll-driven reveal | **mapped to scroll** | linear | `animation-timeline: view()`. Linear maps 1:1 to scroll position — correct here. |
| Continuous rotation / marquee | **varies** | linear | Constant speed is intentional. |

### Spring Presets (Motion Library / React)

| Name | Config | Use for |
|---|---|---|
| Smooth | `damping: 30, stiffness: 200` | Default for most UI transitions |
| Gentle | `damping: 20, stiffness: 120` | Modals, overlays, cards |
| Snappy | `damping: 25, stiffness: 300` | Buttons, toggles, micro-interactions |
| Bouncy | `damping: 12, stiffness: 200` | Celebrations, playful elements |

**Duration-based alternative** (simpler, good for coordinated sequences):
```jsx
transition={{ duration: 0.4, bounce: 0.2 }}
```

### CSS Custom Properties

```css
--transition-interactive: 180ms cubic-bezier(0.16, 1, 0.3, 1);  /* hover, focus, active */
--ease-out:    cubic-bezier(0.16, 1, 0.3, 1);      /* entries, reveals */
--ease-in:     cubic-bezier(0.4, 0, 1, 1);          /* exits only */
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);        /* morphs, layout shifts */
```

---

## Hover & Interactive States

**Cardinal rule: hover states are only for clickable elements.** Before adding `:hover`, ask: *does clicking this do something?* If no → no hover state. Buttons, links, clickable cards, nav items, toggles, icon buttons → yes. Headings, paragraphs, static cards, decorative containers, badges → never.

### Webapp Template: Elevation System

**If you are using the fullstack webapp template** (Express+Vite+React+Tailwind+shadcn), hover/active states use the **elevation system** instead of the CSS transitions below. The template's `index.css` provides overlay-based brightness classes that work in both light and dark mode:

- `hover-elevate` — subtle brightness increase on hover
- `active-elevate-2` — stronger brightness shift on press
- `toggle-elevate` + `toggle-elevated` — persistent toggle state

`<Button>` and `<Badge>` already have elevation baked in — **never add manual hover/active styles to these components**. For custom interactive elements, add `hover-elevate active-elevate-2` classes. See `references/shadcn_component_rules.md` for full details.

The CSS transition patterns below apply to **informational sites, games, and non-template React projects** where you're building hover states from scratch.

### The System Constant (Informational / Game / Custom)

```css
--transition-interactive: 180ms cubic-bezier(0.16, 1, 0.3, 1);
```

Apply to every element with a hover state. List properties individually — **never `transition: all`**.

```css
.btn {
  transition: background var(--transition-interactive),
              color var(--transition-interactive),
              box-shadow var(--transition-interactive),
              transform var(--transition-interactive);
}
.btn:hover  { transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn:active { transform: translateY(0); box-shadow: var(--shadow-sm); }

a { transition: color var(--transition-interactive), text-decoration-color var(--transition-interactive); }

.card[href], a.card {
  transition: box-shadow var(--transition-interactive), transform var(--transition-interactive), border-color var(--transition-interactive);
}
.card[href]:hover  { transform: translateY(-2px); box-shadow: var(--shadow-md); }
.card[href]:active { transform: translateY(0); }

.icon-btn { transition: color var(--transition-interactive), background var(--transition-interactive); }
input, textarea, select { transition: border-color var(--transition-interactive), box-shadow var(--transition-interactive); }
```

**Rules:** Pair hover with `:active` (hover lifts, active pushes down). `:focus-visible` same as hover + focus ring. Mobile (`@media (hover: none)`): `:active` only.

---

## Cursor States

`pointer` → clickable (buttons, links, cards, toggles). `default` → static. `grab`/`grabbing` → draggable. `not-allowed` → disabled (`opacity:0.5` + `pointer-events:none`). `zoom-in`/`zoom-out` → expandable images. `col-resize`/`row-resize` → resizable. Never `cursor:pointer` on non-interactive elements.

---

## GSAP SVG Plugins

GSAP's SVG plugins (DrawSVG, MorphSVG, MotionPath) are free and handle what CSS cannot — morphing between shapes with different point counts, drawing partial paths, and motion along curves.

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/DrawSVGPlugin.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/MorphSVGPlugin.min.js"></script>
<script>
  gsap.from('.logo-path', { drawSVG: '0%', duration: 1.5, ease: 'power3.out' });
  gsap.to('#circle', { morphSVG: '#star', duration: 1, ease: 'power2.inOut' });
  gsap.to('.dot', {
    motionPath: { path: '#curve', align: '#curve', alignOrigin: [0.5, 0.5] },
    duration: 3, ease: 'none', repeat: -1
  });
</script>
```

---

## Motion Rules (Summary)

No instant show/hide — everything animates. Shared elements morph between states. Directional consistency (right → enters from right, back → from left). Persistent elements stay put across transitions. Text changes morph (torph or crossfade). Only animate what changes. Loading states travel to where results appear. Stagger: 40-60ms per item. Scroll reveals: `opacity`/`clip-path`/`filter` only — never `translateY` (CLS). Respect `prefers-reduced-motion`.