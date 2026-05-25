# Design Taste

Interaction quality — the "feel" of a product. Visual aesthetics are necessary but insufficient. A site must feel alive, intentional, and crafted.

---

## Simplicity — Gradual Revelation

- **One primary action per view.** Two equally weighted CTAs = failure.
- **Progressive disclosure over feature dumps.** Layered trays, step-by-step flows, expandable sections. Never show a 12-field form when 3 steps of 4 fields works.
- **Context-preserving overlays** over full-page navigations. Sheets/modals that overlay the current context keep users oriented.
- **Vary heights of stacked layers** so depth progression is unmistakable.
- **Every overlay needs a title and dismiss action.** Users must always know what they're looking at and how to get back.

**Self-check**: Can the user tell within 1 second what to do next? If not, simplify.

---

## Fluidity — Seamless Transitions

Covered in detail in `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/03-motion.md`. The core principle: treat your app as a space with unbreakable physical rules. Every element moves *from* somewhere *to* somewhere. Nothing teleports.

---

## Delight — Selective Emphasis

| Feature | Frequency | Delight Level | Pattern |
|---|---|---|---|
| Number input | Daily | Subtle | Commas shift position as digits are typed |
| Tab navigation | Daily | Subtle | Arrow icon flips direction with value change |
| Empty state | First visit | Medium | Animated arrow + floating illustration |
| Item reorder | Occasional | Medium | Stacking animation + smooth drop |
| Delete/trash | Occasional | Medium | Item tumbles with satisfying motion |
| Critical completion | Once | Theatrical | Confetti explosion + celebratory sound |
| Easter egg | Rare | Theatrical | Hidden gesture reveals hidden moment |

- **Polish everything equally.** The settings page, the empty state, the error screen — all receive the same care as the hero section.
- **Animate numbers** when values change — count, flip, or morph.
- **Empty states are first impressions.** An animated arrow, a warm message. Never just "No items."
- **Celebrate completions.** Significant actions deserve a custom animation.
- **At least one moment** makes someone say "oh, that's nice."

---

## Defensive UI — Skeleton, Empty, Error, and Fallback States

A polished interface handles every state, not just the happy path. Design skeleton, empty, error, and broken image states with the same care as the hero section.

### Skeleton Loaders

Every data-loading view shows a skeleton matching the real layout.

```css
@keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
.skeleton {
  background: linear-gradient(90deg,var(--color-surface-offset) 25%,var(--color-surface-dynamic) 50%,var(--color-surface-offset) 75%);
  background-size:200% 100%; animation:shimmer 1.5s ease-in-out infinite; border-radius:var(--radius-sm);
}
.skeleton-text { height:1em; margin-bottom:var(--space-2) }
.skeleton-text:last-child { width:60% }
.skeleton-heading { height:1.5em; width:40%; margin-bottom:var(--space-4) }
.skeleton-avatar { width:40px; height:40px; border-radius:var(--radius-full) }
.skeleton-image { aspect-ratio:16/9; width:100% }
```

Skeleton mirrors the component structure (avatar→circle, title→bar, text→bars). Surface tokens for colors. Gentle 1.5s shimmer. Respect `prefers-reduced-motion` (static fallback).

### Empty States

Never "No items." Every empty state needs: (1) warm message explaining what goes here, (2) primary action to resolve it, (3) a visual (icon/illustration/animation).

```html
<div class="empty-state">
  <div class="empty-state-icon"><i data-lucide="folder-open"></i></div>
  <h3>No projects yet</h3>
  <p>Create your first project to get started.</p>
  <button class="btn btn-primary">Create project</button>
</div>
```
```css
.empty-state { display:flex; flex-direction:column; align-items:center; text-align:center; padding:var(--space-16) var(--space-8); color:var(--color-text-muted) }
.empty-state-icon { width:48px; height:48px; margin-bottom:var(--space-4); color:var(--color-text-faint) }
.empty-state h3 { color:var(--color-text); margin-bottom:var(--space-2) }
.empty-state p { max-width:36ch; margin-bottom:var(--space-6) }
```

### Image Fallbacks

Every `<img>` handles failure. CSS: `img { background: var(--color-surface-offset) }`. JS: on `error`, replace with a `.img-fallback` div (`role="img"`, `aria-label` from alt, placeholder SVG, `background:var(--color-surface-offset)`).

### Error States

Inline errors (validation) → next to the element, `--color-error`, specific message ("Email is required" not "Error"). Page errors (404, network) → treat as empty state with message + action. Never raw error codes. Use `--color-error` sparingly.

**The principle:** Every state is a designed state. If the user can see it, it must look intentional.