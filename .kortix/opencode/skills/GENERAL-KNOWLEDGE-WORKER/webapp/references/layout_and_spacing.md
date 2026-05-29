# Layout and Spacing

## Layout Rules

- **No layout changes on hover.** To achieve this:
  - If an element is hidden until hover, toggle `visibility: hidden` instead of `display: none`. Changing `display` on hover causes layout shifts.
  - Elements should never change size when hovered.
  - Elements should never be rendered/removed on hover—they should always be present with visibility toggled.

- Any element with `position: sticky` (or the `sticky` Tailwind class) should have a very high `z-index` (higher than anything else on the page).

- **Never use `display: table`** (or equivalent Tailwind utilities). This causes items to be wider than their container even with `width: 100%`.

- If a "left nav" or "right nav" has a header, and the main column also has a header, those headers should be exactly equal height—even if the center column header is non-sticky.

## Flexbox Spacing

When using `justify-between`, `justify-around`, or `justify-evenly`, you **must** also apply `space-x-*` or `gap` classes to handle scenarios where there isn't enough space:

```tsx
// Bad - no gap spacing with justify-between
<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">

// Good - includes gap with justify-between
<CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
```

Horizontal flex rows with `justify-start`, `justify-end`, or no `justify-*` specified should **always** include `flex-wrap`.

## Button Sizing

When using shadcn `<Button>`s, never control padding or height explicitly—use the sizes and variants offered by the Button API.

## Consistency

- Spacing should be consistent. All panels/card elements should have the same padding around their inner content unless there's strong justification to deviate.
- Use only a few levels of spacing: small, medium, and large. Choose suitable values based on information density.
- If a text input has an embedded icon, use the "small" amount of space to its left and right.
- No two elements with visual borders and/or elevated hover states should be touching—there must be spacing between them.
- Be opinionated about flat design vs. bordered design and apply consistently.
