# Shadcn Component Rules

## Hover and Active Interactions

If elements transform (scale, etc.) on hover or press down (active state), the transform should be **extremely subtle**—just enough to notice. Don't overdo it.

For `<Button>` and `<Badge>` (Shadcn components), hover and active states are already preconfigured automatically regardless of variant. You do **not** need to supply additional classes.

### Elevation Utility Classes

Two special Tailwind utility classes are defined in `index.css`:

- `hover-elevate`: Applies subtle elevation on hover that respects the current theme
- `active-elevate-2`: Applies more dramatic elevation on press-down that respects the current theme

**Important constraints:**

- These utility classes will **not** work with `overflow-hidden` or `overflow-scroll` and **must not** be used with them.
- They compose well with any background color (or even no background).

```tsx
// Good
<AnyComponentThatHasOverflowVisible className="hover-elevate" />

// Bad - has overflow-hidden
<AnyComponentThatHasOverflowHidden className="hover-elevate" />

// Bad - forcing overflow-hidden with elevate utility
<AnyComponent className="overflow-hidden hover-elevate" />
```

### Built-in Component Behavior

`<Button>` and `<Badge>` already apply `hover-elevate` and `active-elevate-2`. Therefore:

- **Never** apply hover/active states that change their background/foreground colors.
- If you see `hover:bg-*` on a button or interactable control, that is a **red flag**.

```tsx
// Bad - don't need hover states on sidebar buttons
<SidebarMenuButton className="data-[active=true]:bg-sidebar-accent hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">

// Good - styling 'currently selected' without hover interactions
<MyCustomButton className="data-[active=true]:bg-sidebar-accent hover-elevate active-elevate-2">

// Bad - Button already has hover/active elevations
<Button className="hover-elevate">

// Good - disabling default elevations when needed
<Badge className="no-default-active-elevate" />
```

### Toggle Elements

Turn any element into a toggle using the elevate system:

```tsx
// Add toggle-elevate class, then add toggle-elevated when "on"
<Button type="icon" variant="ghost" className="toggle-elevate toggle-elevated" />
```

## Component Usage Rules

### Use Default Shadcn Components

**Always** use the default Shadcn components from `client/src/components` when a reusable base component exists.

**Exception:** When the user explicitly requests something else or needs functionality not supported by base Shadcn components.

Examples:

- Use existing `<Card>`, `<Button>`, and `<Badge>` components instead of creating your own.
- If your application needs a sidebar, you **must** use the existing Shadcn sidebar primitives from `@/components/ui/sidebar`.

## Button Component

The built-in `<Button>` has several size/color variants. All variants support automatically adjusting background colors on hover/active using the elevation system.

- **Never** implement different hover/active colors for buttons in headers, sidebars, or cards.
- Even with custom background colors, do **not** implement your own hover/active states.

## Card Component

- **Must** use the built-in Shadcn `<Card>` component for card-like backgrounds/borders.
- **Never** nest a Card (or `bg-card`) inside another Card (or `bg-card`).

## Cards in Sidebars

- A Card should **never** be used *as* a sidebar or stretch the full width/height of a sidebar/header.
- Elements with rounded corners **must** only be placed in containers with padding to prevent corners from touching the boundary.
- When nesting a Card inside a sidebar/header, ensure there's at least small contrast between container background and Card background.

## Borders on Rounded Elements

**Never** apply border to one, two, or three sides of a rounded element/component:

```tsx
// Bad - border-l-4 on rounded element
<div className="border-l-4 border-l-primary rounded-md">

// Good - no partial border on rounded element
<div className="pl-4 group rounded-md">

// Bad - Cards are rounded, so one-sided border is a problem
<Card className="border-l-4 border-l-primary">

// Bad - Buttons are rounded
<Button className="border-l-4 border-l-primary">
```

`<Button>`, `<Card>`, and `<Badge>` already implement their own borders—no need to add additional borders.

## Badge Component

All `<Badge>`s are configured to not wrap white space and their overflow is hidden by default. All contents will be on one line. Place them where they have sufficient room to grow in width.

## Icon Buttons

For buttons containing only an icon, use `<Button size="icon" />`:

```tsx
// Good
<Button size="icon" variant="ghost">
  <MyLucideIcon />
</Button>

// Good
<Button size="icon" variant="default">
  <Plus className="w-3 h-3" />
</Button>

// Bad - don't create your own icon buttons with custom width/height
<Button size="sm" className="w-8">
  <MyLucideIcon />
</Button>

// Bad - don't resize size="icon" buttons
<Button size="icon" className="h-4 w-4">
  <Plus className="w-3 h-3" />
</Button>
```

When you see `size="icon"`, there should **not** be any `h-*` or `w-*` classes added.

## Textarea Component

Do **not** reset padding to zero on Shadcn `<Textarea />`:

```tsx
// Bad - has p-0
<Textarea
  placeholder="What's on your mind?"
  className="resize-none border-0 p-0 text-base focus-visible:ring-0"
/>

// Good
<Textarea
  placeholder="What's on your mind?"
  className="resize-none border-0 text-base focus-visible:ring-0"
/>
```

## Avatar Component

Use the existing Shadcn Avatar components (or Radix Avatar) unless the user requests otherwise. Use `AvatarFallback` when there's no image for `AvatarImage`.

## Buttons Over Images

When placing a `<Button>` on top of an image, you may need to set custom background color. In these cases:

- **Must** set a corresponding border color that matches (e.g., `bg-accent` with `border-accent-border`).
- Still do **not** implement your own hover/active states.

For `variant="outline"` over an image:

- You don't need to supply border/color or hover/active states.
- Set a blurred background—sometimes mixed with a very low opacity version of `bg-background`.

**Never** set a background color with a mismatched border color (e.g., never use "primary" based background with "accent" based border).

## Element Dimensions

Two classes of elements should **never** have height, padding, or text size manually configured:

1. **Interactable controls:** Clickable elements, focusable text inputs, selector-style components
2. **Pills, badges, and tokens:** Visually distinguished non-interactable elements

Badges and tokens should have smaller height than interactable controls—use small size Badges.

### Button Height Reference

| Size                       | Height     |
|----------------------------|------------|
| `default` (or unspecified) | `min-h-9`  |
| `sm`                       | `min-h-8`  |
| `lg`                       | `min-h-10` |
| `icon`                     | `h-9`      |

**Interactable controls on the same horizontal line should be the same height.**

```tsx
// Good - Button's default size (min-h-9) matches sibling div
<Button size="default">btn</Button>
<div className="h-9">click me</div>

// Bad - mismatched heights
<Button>btn</Button>
<div className="h-3">click me</div>

// Bad - the square is not the same size
<MySearchComponent className="h-7">Search for things</MySearchComponent>
<div className="h-8 w-8"><ThemeToggle/></div>
```

Note: Badges are not interactable controls and can have different (smaller) heights than interactable controls on the same line.
