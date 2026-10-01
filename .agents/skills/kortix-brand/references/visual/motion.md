# Motion

Values live in `visual-system.json` (keys `motion.*`, `effects.press.*`). The tokens compile: `duration-fast`, `duration-normal`, `duration-moderate`, `duration-slow` and `duration-slower` are real utilities (`decisions.md` D3, J-8). Before 2026-10-01 they emitted no CSS, and every call site ran at 150ms.

**Rule.** Product motion is 300ms or less, or none. — *Why:* speed is the product. A reviewer must notice the interface, not the animation. — *Where:* app | mobile. — *When silent:* no animation.

Animation exists to make the UI feel faster, or to show where a thing came from.

## Pass 0: the frequency ladder

**Rule.** Count how often a user sees the thing in a working day, before you choose a duration. Frequency sets the budget. Nothing else does: not how it looks in isolation, not how much effort it took. — *Why:* a demo is one viewing. The fiftieth viewing is the design target. — *Where:* app, mobile. Marketing and decks use the last row. — *When silent:* the answer to "should this animate?" is no. Replay the interaction ten times. If you still notice the motion, cut it.

| Seen | Budget | Examples |
| --- | --- | --- |
| **Constantly**, tens of times an hour | **None.** `transition-none` | Keyboard list nav, row hover in a dense list, focus moves, selection in a table, anything an arrow key drives, **every menu, select, popover, tooltip, submenu and the command palette opening or closing** |
| **Often**, several times a session | **100 to 200ms**, opacity and transform only | Hover on a non-dense target (`duration-fast`), tab switch and disclosure (`duration-moderate`) |
| **Occasionally**, once or twice a session | **200 to 300ms** | Modal, sheet, drawer, toast, panel swap, hover card |
| **Rarely**, first run or a moment worth marking | **300ms or less**, blur allowed on a state swap | Empty to first content, a completed deploy, a destructive confirm |
| **Marketing and decks** | **up to 500ms**, one hero moment per viewport | Landing intro, feature illustration, deck build step |

**Rule.** Never animate a keyboard-initiated action. — *Why:* a user drives them hundreds of times a day. Motion makes the interface feel laggy and disconnected from the key just pressed. — *Where:* app, mobile (hardware keyboard), deck engine navigation. — *When silent:* no exceptions.

## Instant floating panels (D4a)

**Rule.** Open and close menus, selects, popovers, tooltips, submenus and the command palette with no animation. Modals, sheets and toasts keep 200 to 300ms. The hover card is the one animated floating panel. — *Why:* Radix `Presence` kept each panel mounted until its animate-out ended, "so every open and close waited 150 to 200ms" (#7301). The palette is "opened dozens of times a day, almost always from the keyboard" (#7675). "A submenu opens into the pointer's path, so about 150ms of animate-in was spent moving rows away from the cursor" (#7067). — *Where:* app. — *When silent:* if the panel opens from a trigger and closes on outside click, it is instant. Use `MENU_PANEL_STATIC` or `FLOATING_PANEL_SURFACE` from `menu-recipe.ts`. The animated `MENU_PANEL` and `FLOATING_PANEL` are for the hover card only. The context menu still uses the animated one: that is debt, not a precedent.

**Rule.** Pin the command palette 17vh from the top at 600px wide. — *Why:* the input stays still while the list height changes (#7675). — *Where:* app. — *When silent:* copy `features/workspace/command-palette.tsx`.

**Rule.** Scale a hover card from its trigger: `transform-origin: var(--radix-hover-card-content-transform-origin)`. The `center` default reads as a floating box. — *Why:* the hover card is the one panel that animates, so it must come from somewhere. — *Where:* app. — *When silent:* `hover-card.tsx`.

**Rule.** Show the first tooltip after a delay (150ms, `TooltipProvider`), then no delay and no animation for the next ones while the group is active. — *Why:* the delay prevents accidental activation. Repeating it makes the UI feel slow. The delay moved from 300ms to 150ms (#7301). — *Where:* app. — *When silent:* inherit the provider.

**Rule.** Drive pointer hover highlights from CSS `:hover`, never from React state. Keyboard mode uses `data-selected`. — *Why:* a re-render on every pointer move is lag. The palette writes `data-nav="pointer" | "keyboard"` to the DOM with no re-render (#7301). — *Where:* app. — *When silent:* CSS first.

## Easing

| Curve | Use it for | Notes |
| --- | --- | --- |
| **`ease-out`** | **Enter and exit.** Anything appearing or leaving. | The default. Fast at the start feels responsive. Reach here first. |
| `ease-in-out` | Elements already on screen that move, resize or morph | Accelerate, then decelerate. |
| `ease-default` | The Kortix house curve (`motion.easing.default`), where a named curve is wanted | A real utility, from `--ease-default`. |
| `linear` | Marquee, progress, hold-to-delete, continuous rotation | Only where a constant rate is the meaning. |
| **`ease-in`** | **Nothing.** | Starts slow, so the UI feels sluggish. Add none. |

**Rule.** Use `ease-out` for enter and for exit. Never use `ease-in` or `linear` on a UI transition. Never write bare `ease` as a class: it is not a Tailwind utility and emits no CSS. — *Why:* easing changes perceived speed independently of time. `ease-in` and `linear` are the two ways a surface starts to feel slow. — *Where:* app, marketing, mobile, deck. — *When silent:* `ease-out`. For a color or background hover, use `transition-colors` with the default easing.

## Duration

**Product motion stays at 300ms or less.** Over 300ms is a marketing budget, or a bug.

| Token | Value | Use |
| --- | --- | --- |
| `duration-fast` | 100ms | Hover color and opacity |
| `duration-normal` | 150ms | **The default UI transition** |
| `duration-moderate` | 200ms | Disclosure, accordion, tab |
| `duration-slow` | 300ms | Modal, drawer, sheet. The ceiling. |
| `duration-slower` | 500ms | Marketing and decks only |

**Rule.** Write the token, not the number. Write `duration-normal`, not `duration-150` and not `duration-[150ms]`. — *Why:* raw values outnumber tokens in the codebase because the tokens used to be dead. They are real now, and a raw value is debt. `duration-80` (in `card.tsx` and `switch.tsx`) is off the ladder: pick `duration-fast`. — *Where:* app, marketing. — *When silent:* nearest token. The audit maps 100, 150, 200 and 300 to their token names.

**Rule.** Go longer than 300ms only for a large element (bigger reads as heavier, so it moves slower) or a steep custom curve, and write a comment that names which. — *Why:* "it looks nicer" is not a reason. — *Where:* app. — *When silent:* 300ms.

## Properties

**Rule.** Animate `opacity`, `transform`, `filter`, `color` and `background-color`, and nothing else. — *Why:* these are compositor-friendly. The rest cause layout and drop frames. — *Where:* app, marketing, mobile. — *When silent:* for a height, use a grid-rows or `motion/react` height animation, not a CSS height transition. Never animate `height`, `width`, `top`, `left` or `margin` with a CSS transition.

**Rule.** Never write `transition-all` or bare `transition`. Name the property: `transition-colors`, `transition-transform`, `transition-opacity`. Explicit lists like `transition-[max-width,opacity]` are fine. — *Why:* an unnamed transition animates every property that changes, on every state change. The ban is on unnamed transitions, not on the bracket syntax. — *Where:* app, marketing. — *When silent:* name it.

## Fixed values

| Thing | Value | Why |
| --- | --- | --- |
| Button press | `active:scale-[0.96]` (`effects.press.button`) | The house press. It makes the UI feel like it is listening. |
| Full-width row press | `active:scale-[0.998]` (`effects.press.row`) | A larger element gets a smaller scale (D4k). A 0.96 scale on a wide row moves its edges visibly. |
| Form field press | none | An input never scales, and a select beside it behaves the same (#8286). The borderless toolbar trigger keeps 0.98 in `trigger-variants.ts`. |
| Enter scale floor | 0.9 to 0.97 (`motion.enter_scale_floor`) | **Never `scale(0)`.** Things do not come from nothing. The sanctioned icon-swap morph from 0.25 is in `kortix-design-system`. |
| Spring | `{ type: 'spring', duration: 0.3, bounce: 0 }` (`motion.spring`) | `bounce: 0` is the brand: the spring settles with no overshoot. |
| Bounce above 0 | drag-release gestures only | A drag applied force, so a settle reads as physical. A click did not. `lib/springs.ts` (`bounce: 0.12`) and the onboarding seal (`bounce: 0.28`) pre-date this rule and are debt. |
| Blur bridge | `filter: blur(4px)` to `blur(0)` | Only to bridge a state swap where two objects would blink. Never on text the user is reading. |

**Rule.** Make a hover effect change color, background, opacity or `transform`, never position in flow. — *Why:* a hover that shifts layout moves the element from under the cursor and flickers between states. — *Where:* app, marketing. — *When silent:* color only.

**Rule.** Enter with opacity, or opacity plus a scale from the enter floor. Never use opacity with a large `y` translate. — *Why:* a large translate moves the text the user wants to read, and every item in a list pays the delay. — *Where:* app | marketing. — *When silent:* opacity only.

**Rule.** Write hover as `hover:`. Tailwind v4 already gates it to hover-capable devices. Do not hand-roll a hover effect that fires on touch. — *Why:* touch has no hover. — *Where:* app, marketing. — *When silent:* `hover:`.

## Reduced motion

**Rule.** Ship two variants of every animation. `prefers-reduced-motion: reduce` means remove the movement, not the feedback. Keep opacity and color. Drop `transform` and anything that translates or scales. — *Why:* accessibility is priority 1. — *Where:* app, marketing, mobile, deck. — *When silent:* ship both variants in the same change.

```tsx
// Tailwind
className="motion-safe:transition-transform motion-reduce:transition-opacity"
```

```tsx
// motion/react
const reduce = useReducedMotion();
<motion.div animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }} />
```

## Orchestration

**Rule.** Move one thing at a time. A stagger is a marketing device. — *Why:* in product UI a staggered list is strictly slower to read and to click than the same list appearing at once. The delay is charged to the user every time. — *Where:* app, mobile: never. Marketing: once, on the intro. — *When silent:* everything appears at once.

Waiting-screen rules (one channel, progress follows the backend) live in [layout.md](layout.md), section States.

## Busy and loading marks

**Rule.** Use `Loading` as the spinner everywhere. Never spin an icon (`animate-spin` on a refresh glyph). — *Why:* one spinner reads as one product. — *Where:* app, marketing. — *When silent:* `Loading`. The refresh-icon spinners in `infrastructure-preview.tsx`, `sandbox-url-detector.tsx` and `tool-action-bar.tsx` are debt: replace them with `Loading`.

**Rule.** Use `SessionDotMatrix` as the busy mark for session-scoped work (D4f), for example an approve or deny button while a decision saves (#8421). — *Why:* it marks "this session is doing something" and is stable per `session_id`. — *Where:* app. — *When silent:* if the work is not tied to one session, use `Loading`.

**Rule.** The page-level loading mark is `ProjectPendingScreen`: the pulsing Kortix mark, opacity only, behind `motion-safe`. It never spins. — *Why:* signing in paints this mark once and holds it across three navigations (#7179, #7263, D4h). — *Where:* app. — *When silent:* layout in `layout.md`.

## Per surface

| | app | marketing | mobile | deck | image | email | CLI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ceiling | 300ms, one thing | 500ms, one hero moment | native defaults | build steps; 500ms | none | none | none |
| Floating panels | instant; hover card animated | instant menus | native sheets | n/a | n/a | n/a | n/a |
| Stagger | never | once, intro | never | build steps are the stagger | n/a | n/a | n/a |
| Reduced motion | required | required | required (`useReducedMotion`) | required | n/a | n/a | n/a |
| Tokens | `duration-*` | `duration-*` | `MOTION` in `apps/mobile/lib/utils/theme.ts` (numbers, pinned by `theme.test.ts`) | same as marketing | n/a | n/a | n/a |

**Mobile.** Every stack uses expo-router's native `Stack` with the platform push and pop. Write no custom screen animation. The root `index` redirect has `animation: 'none'`. Feedback is a toast (`useToast()`), never `Alert.alert`.

**Deck.** Never mount or unmount on a build step. Every element is in the DOM from the first frame, ghosted, and a step raises its opacity (`transition-opacity duration-slower`, ghost at the low-opacity step). Connector rails never fully fade. Only ghosted nodes drop further. A travelling packet (`Link fire`) is the one element that mounts for its step. Caption carries the sentence that changes per step. About 20 seconds of narration per build step. Films run at 60fps on a 120 BPM bar grid, one bar = 120 frames, and every frame is a pure function of the frame number (`kortix-presentation/references/films.md`).

**Marketing.** An intro animation plays once per visit and must not replay on back-navigation. One hero moment per viewport.

**Email, image, CLI.** No motion. A CLI prints plain lines.

## Rationalization table

| Thought | Reality |
| --- | --- |
| "A little animation would delight the user" | The user has a goal, not a wish to be delighted. Delight that repeats becomes friction. |
| "It is only 400ms, that is still quick" | Product ceiling is 300ms. 400ms is a marketing budget in a product surface. |
| "The stagger makes the list feel considered" | It makes the list slower to read and click, every time. |
| "`transition` is shorter to type than `transition-colors`" | It animates properties you did not choose. Name the property. |
| "This dropdown animation looked great in the demo" | A demo is one viewing. Estimate the fiftieth. |
| "I will add `prefers-reduced-motion` later" | It is the second half of the animation. Ship both. |
| "`ease-in` looks smoother on the way out" | It starts slow, so the UI reads as sluggish. `ease-out` for enter and exit. |
| "The popover should scale from its trigger" | Menus, selects and popovers are instant now. Only the hover card scales. |
| "I will use `duration-150`, it is the same" | Write `duration-normal`. The token is real. |
| "Fade up from 24px looks polished" | A large translate delays reading. Use opacity only. |

