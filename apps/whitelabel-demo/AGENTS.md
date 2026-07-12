# AGENTS.md — Lumen (white-label reference app)

Lumen is the **golden reference** for building on `@kortix/sdk`. Two things must
stay true at all times:

1. **Every Kortix call goes through the SDK.** No raw `fetch`, no native harness
   SDK imports, no transport/runtime code in the app. The single
   client lives in `src/lib/kortix.ts`; data flows through `@kortix/sdk` +
   `@kortix/sdk/react` (notably `useSession`).
2. **Every pixel is shadcn.** This app is the shadcn showcase. The UI must look
   and feel Vercel-grade and be built from shadcn primitives — never bespoke
   markup where a primitive exists.

If a change violates either rule, it's wrong. Fix the rule, not the symptom.

**Exception — the wrapper-mode BFF transport layer.** `src/server/**` and
`src/app/api/**` (the `/api/kortix` proxy, `/api/auth/*`, `/api/usage`,
`/api/preview-token`, `/api/mode`) are server-only transport code, not app
code — raw `fetch`/`node:crypto`/`node:fs` are correct there, the same way
they're correct *inside* `@kortix/sdk` itself. Rule 1 still governs every
client component: the browser only ever talks to Kortix through
`@kortix/sdk`, pointed at `/api/kortix` instead of a real Kortix deployment
when wrapper mode is on (`src/lib/kortix.ts#configureWrapperMode`).

## UI rules (strict shadcn)

- **Use shadcn primitives, always.** Buttons → `Button`, inputs → `Input`/
  `Textarea`, menus → `DropdownMenu`, dialogs → `Dialog`, tabs → `Tabs`, lists/
  cards → `Card`, badges → `Badge`, tooltips → `Tooltip`, scroll regions →
  `ScrollArea`. Do **not** hand-roll a styled `<button>`, `<input>`, or ad-hoc
  dropdown when the primitive exists.
- **Chat is built from the shadcn chat primitives that exist in this app
  (`src/components/ui/`):**
  - `Message` + `MessageGroup` / `MessageAvatar` / `MessageContent` /
    `MessageHeader` / `MessageFooter` (`message.tsx`) — one row per turn
    (`align="end"` for the user, `"start"` for the agent).
  - `Bubble` + `BubbleContent` / `BubbleReactions` / `BubbleGroup`
    (`bubble.tsx`) — the message surface (`variant` + `align`).
  - `Marker` + `MarkerIcon` / `MarkerContent` (`marker.tsx`) — inline tool-call
    / status / "thinking" rows and labeled separators.
  - The transcript container itself is a plain `scrollRef` + `scrollTo` effect
    (`workbench-tabs.tsx`), not a dedicated primitive — there is no
    `MessageScroller` or `Attachment` component in this app. Don't add code
    that imports either; if a chat surface needs file attachments or a
    fancier auto-scroll/jump-to container, build it as a new primitive under
    `src/components/ui/` to the shadcn API shape (see "Adding shadcn
    components" below), not as bespoke markup in a feature component.
- **Streaming/pending text uses the `shimmer` util**; scroll containers that need
  soft edges use the `scroll-fade` util (both in `globals.css`).
- **Styling:** Tailwind v4 + the theme tokens in `globals.css` only. Compose
  classes with `cn()` (`@/lib/utils`); variants with `cva`
  (`class-variance-authority`). No inline hex/rgb — use the CSS variables
  (`bg-card`, `text-muted-foreground`, `border-border`, `bg-secondary`, …).
- **Icons:** `lucide-react` only.
- **Dark-first.** The theme is dark by default; every component must read well in
  dark mode (use tokens, not fixed colors).
- **Accessibility:** real labels (`aria-label`) on icon-only buttons; keyboard
  paths work (Enter to send, Esc to close, arrow keys in menus).

## Adding shadcn components

```bash
pnpm dlx shadcn@latest add <name>      # e.g. button, dialog, message, bubble
```

The chat primitives this app actually has (`message`, `bubble`, `marker`) and
the `shimmer` / `scroll-fade` utils are part of this app. If the public
registry can't resolve one yet, the equivalent lives in `src/components/ui/`
built to the **exact documented shadcn API** — drop-in, so a later `shadcn add`
overwrites cleanly. Never fork the API.

## Structure

- `src/lib/kortix.ts` — the one SDK client (`createKortix`), plus
  `configureWrapperMode()` to re-point it at the BFF proxy.
- `src/components/ui/` — shadcn primitives only (generated or built-to-spec).
- `src/components/chat/` — chat surface composed from the chat primitives.
- `src/components/workbench/` — the session workbench (header, tabs, panels).
- `src/app/**` — routes; thin, delegate to components.
- `src/app/api/**` + `src/server/**` — wrapper-mode-only transport (BFF proxy,
  demo auth, route policy, rate limiting). See the exception above; this is
  the one place raw `fetch`/`node:crypto` is correct.

## Quality bar

`pnpm typecheck` must be clean before any commit. Match the surrounding code's
density and idiom. Prefer composition over props-explosions. The result should be
indistinguishable from a first-party Vercel product.
