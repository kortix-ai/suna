# Project Home Capability Carousel

Issue: JAY-601

## Problem

The project home renders six setup actions as a wrapped button row. The row competes with the composer and personalized starter suggestions. It also gives every setup action equal prominence.

The supplied Manus reference uses one focused recommendation tile with direct pagination. The visible recommendation changes automatically without expanding the page.

## Scope

Replace `ProjectHomeSections` in `apps/web/src/features/workspace/project-layout/project-home.tsx` with one rotating capability tile.

The carousel contains these four slides in this order:

1. Slack
2. Connect 3000+ apps
3. Create skills
4. Create agents

Remove Scheduled tasks and Your team from this project-home surface. Their routes and settings remain unchanged elsewhere.

The visible copy is fixed:

| Slide | Description |
| --- | --- |
| Slack | Run this project right from Slack. |
| Connect 3000+ apps | Connect tools your agent can act in. |
| Create skills | Automate workflows with reusable skills. |
| Create agents | Shape how your agent thinks and acts. |

## Visual design

The carousel follows the supplied Manus composition:

- One wide tile is visible at a time.
- The tile uses `rounded-md border bg-popover px-3 py-2`.
- The text block sits on the left.
- The title uses `text-base font-medium`.
- The description uses `text-muted-foreground text-sm`.
- A restrained icon illustration sits on the right.
- Four small circular indicators sit in one centered row below the tile.
- The active indicator has stronger foreground contrast.
- The tile height remains fixed across all four slides.
- Narrow layouts keep the copy readable and preserve the right-side illustration without horizontal overflow.

The implementation uses existing semantic tokens and Phosphor or existing product icons. It does not add raw colors, decorative gradients, shadows, or a new shared primitive.

## Interaction

The whole tile is a button.

Each slide keeps its existing destination:

| Slide | Destination |
| --- | --- |
| Slack | Open the `channels` settings section |
| Connect 3000+ apps | Navigate to the project Connectors capability page |
| Create skills | Navigate to the project Skills capability page |
| Create agents | Navigate to the project Agent capability page |

The carousel advances to the next slide every `2500ms`. It wraps from the fourth slide to the first slide.

Each indicator is a button. Selecting an indicator changes the visible slide and restarts the interval.

Pointer hover and keyboard focus pause automatic rotation. Leaving the carousel resumes rotation with a new interval.

## Motion

The transition is a crossfade: one slide fades out while the next slide fades into the same slot. The entering content translates upward by `4px`. The tile container does not move or resize.

The transition uses opacity and transform only. It lasts `200ms`. It uses ease-out for entry and a quieter exit.

The first slide does not animate on initial render. The transition remains interruptible when a user selects another indicator.

When `prefers-reduced-motion` is active, the carousel does not auto-advance. Direct indicator selection swaps content without animated movement.

## Accessibility

- The carousel region has an accessible label.
- The tile exposes its action through native button semantics.
- Each indicator has an explicit label such as `Show Create skills`.
- The selected indicator uses `aria-current="true"`.
- Visible indicators can stay small, but each button has at least a `40px` hit area.
- Keyboard focus remains visible.
- Auto-rotation pauses while focus is inside the carousel.
- The carousel does not announce every automatic change through a live region.

## State and data flow

`PROJECT_SETUP_TILES` remains static configuration. It contains the icon, title, description, and destination for each slide.

`ProjectHomeSections` owns the active index and pause state. A single effect owns the interval. Direct selection updates the index. The existing router and settings-panel store perform navigation.

No network request, persistence, migration, or SDK change is required.

## Failure behavior

The slide configuration is static, so the component has no loading or error state. If the list ever contains one slide, it renders that slide without pagination or an interval. An empty list returns `null`.

## Verification

Automated verification covers index wrapping, direct selection, interval reset, pause behavior, and reduced-motion behavior.

Static verification includes focused ESLint and TypeScript checks for the touched files.

Browser verification covers:

1. One tile is visible at a time.
2. The slide changes after `2500ms`.
3. Each indicator selects its slide.
4. Hover and focus pause rotation.
5. Each tile opens the correct destination.
6. The layout matches the supplied reference in light and dark themes.
7. The layout remains usable at a narrow viewport.

## Out of scope

- New capability routes
- Changes to Slack, Connectors, Skills, or Agent pages
- Personalized or server-controlled carousel content
- Swipe or drag gestures
- Previous and next arrow controls
- Changes to starter suggestions
