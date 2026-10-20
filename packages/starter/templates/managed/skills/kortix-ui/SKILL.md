---
name: kortix-ui
description: "Build React UI with @kortix/ui, the Kortix component library: Kortix Apps, white-label hosts, SDK customer apps and apps/web. Load before you write a component, a page, a chat view or a className in a React host that renders Kortix UI, or when you theme Kortix components for another brand. Covers setup, which component to compose, banned primitives, tokens, status tones, the SessionThread chat recipe, white-label theming and the verify steps."
---

# @kortix/ui

`@kortix/ui` is the one React component library for every Kortix surface: `apps/web`, Kortix Apps, the
white-label demo and SDK customer apps. Components are Tailwind v4 class strings that read CSS variables.
Docs: https://kortix.com/docs/sdk/ui. Live catalog: https://kortix.com/design-system.

Availability: a workspace package of `kortix-ai/suna` (`"@kortix/ui": "workspace:*"`), not on npm yet.
Outside it: tell the user, style with plain CSS over the section 6 variables, never copy component source.

## 1. Set up once

1. Styles. A Tailwind v4 host, in its main CSS:
   ```css
   @import 'tailwindcss';
   @import '@kortix/ui/tailwind.css'; /* tokens, component layer, plugins; @source scans the package */
   ```
   Install its optional peers `tw-animate-css`, `tailwind-scrollbar`, `tailwind-scrollbar-hide`.
   A host without Tailwind (plain Vite, a CDN page) imports one file: `import '@kortix/ui/styles.css'`.
   It is prebuilt and has every class the package uses. It has no class you write yourself.
2. Fonts. `@kortix/ui/fonts.css` (Roobert) is for Kortix-owned surfaces only. A white-label host never
   imports it and renders the system stack.
3. Dark mode is the `dark` class on `<html>` (`useIsDark()` reads it). Mount once at the root:
   `UiProvider` (`strings` for translated copy, `chat` included; `link` for your router's link; `useBrand`
   for an organization's logo), `IconProvider` (`@kortix/ui/icon-provider`, the house icon weight; not the icon-set provider of `lib/icon-context`) and one
   `<Toaster />` from `@kortix/ui/toast` for the toast helpers.
4. Import by subpath: `import { Modal } from '@kortix/ui/modal'`. The root `@kortix/ui` holds only the
   light core in section 7. Heavy parts (charts, maps, grids, mermaid, emoji data) load only from their own
   subpath.

## 2. Compose before you create

Reuse, then compose, then create. Find the job below before you write a new component.

| Job | Compose | Subpath |
| --- | --- | --- |
| Dialog or sheet | `Modal`, `ModalContent`, `ModalHeader`, `ModalTitle`, `ModalBody`, `ModalFooter` | `modal` |
| Destructive action | `ConfirmDialog` before the mutation, never a single click | `confirm-dialog` |
| Tooltip on an icon button | `Hint label="…"` | `hint` |
| Toast after a mutation | `successToast`, `errorToast`, `infoToast`, `warningToast`, `loadingToast` | `toast` |
| Status chip | `Badge size="sm"` | `badge` |
| Count beside a label | `CountBadge` (`waiting`, `reminder`, `conflict`, `neutral`) | `count-badge` |
| Inline alert | `InfoBanner tone="…" title="…"` | `info-banner` |
| Pending spinner | `Loading` (default export) | `loading` |
| Expand and collapse | `Disclosure`, `DisclosureTrigger`, `DisclosureContent` | `disclosure` |
| Form field | `Field`, `FieldLabel`, `FieldGroup`, `FieldDescription` with `Input`, `Textarea`, `Select` | `field` |
| Search field | `InputGroupSearch`, `InputGroupSearchInput` | `input-group` |
| Panel | `Card` and its slots, or `bg-popover rounded-md border px-4 py-5` | `card` |
| Buttons side by side | `ButtonGroup` | `button-group` |
| Tabs and filters | `Tabs`, `TabsList`, `TabsListCompact` | `tabs` |
| Menu, picker, palette | `DropdownMenu`, `Popover`, `Command` | `dropdown-menu`, `popover`, `command` |
| Table and empty list | `Table`; `Empty` with one muted line | `table`, `empty` |

A new primitive is the last step: tokens only, a small API, and a section on `/design-system`.
## 3. Banned

| Never | Use |
| --- | --- |
| `Dialog` / `DialogContent` in feature code | `Modal` |
| `Tooltip` primitives in feature code | `Hint` |
| `toast()` from `sonner`, `toast.success()` | the toast helpers and `<Toaster />`, all from `@kortix/ui/toast`; a host needs no `sonner` import |
| An icon with `animate-spin`, `CircleNotchIcon`, `SpinnerIcon` | `Loading` |
| A hand-rolled chip `<span>` or a colored banner | `Badge`, `InfoBanner` |
| `SectionCard`, `List` / `ListRow` | `Card`, `<ul className="space-y-2">` rows |
| `lucide-react` or another icon set | `@phosphor-icons/react`, `*Icon` names, no `weight` prop (only `weight="fill"` for solid status glyphs) |
| A fork or a restyled copy of a component | the component as it ships; theme with tokens (section 6) |

## 4. Tokens only

- Colors are semantic utilities: `bg-background`, `bg-card`, `bg-popover`, `bg-muted`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `bg-primary`, `text-destructive`. Never a hex, `rgb()`,
  `oklch()` or a Tailwind palette class (`text-emerald-600`).
- `--spacing` is `0.23rem`: the scale is 8% tighter than stock Tailwind. A 16px mockup gap is `gap-4`,
  never `gap-[16px]`.
- Radius: `rounded-md` for panels and fields. Elevation is for overlays only; in-flow panels are flat.
- Motion: none by default. Hover is `transition-colors duration-fast`. Nothing over 300 ms in product UI.

## 5. Status tones

One meaning per hue. `StatusTone` (`@kortix/ui/status`) is `success`, `warning`, `destructive`, `info`,
`neutral`. `InfoBanner` takes `tone`; `StatusBadge` and `STATUS_DOT` render it. `Badge` variants map the
same meanings: `success`, `warning`, `destructive`, `info`, `muted`. Brand hues for a tinted icon tile:
`bg-kortix-green/15`, `bg-kortix-orange/15`, `bg-kortix-blue/15`, with the icon in the full hue.

## 6. White-label

Override the CSS variables of `tokens.css` in your own `:root` and `.dark`. `--kortix-blue` is the accent
(checked `Switch` / `Checkbox` / `RadioGroup`, `brand` `Button`, info `Badge` / `InfoBanner`); `--ring` the
focus ring (`--sidebar-ring` and the `--sidebar-primary` selection follow it); `--foreground` / `--background` the page and the default `Button`; `--primary` (ink, not the
accent) `Progress`, `Slider`, menu tint; plus `--radius`, `--font-sans-system`. Pass the organization's marks to `UiProvider useBrand`, so
`KortixLogo` renders them. Never fork a component, never load `fonts.css`, never edit a generated file.

## 7. Components

| Import from | Names |
| --- | --- |
| `@kortix/ui` (adapters) | `cn`, `UiProvider`, `defaultUiStrings`, `defaultChatStrings`, `useUiStrings`, `useUiLink`, `useUiBrand`, `UiStrings`, `UiStringsInput`, `ChatStrings`, `UiLinkProps`, `UiLinkComponent`, `UiBrand`, `UseUiBrand`, `useIsDark` |
| `@kortix/ui` (actions, display) | `Button`, `buttonVariants`, `ButtonProps`, `Badge`, `badgeVariants`, `Card`, `CardAction`, `CardButton`, `CardContent`, `CardDescription`, `CardEyebrow`, `CardFeature`, `CardFooter`, `CardGroup`, `CardHeader`, `CardImage`, `CardMedia`, `CardTitle`, `CardButtonProps`, `CardButtonSize`, `CardButtonVariant`, `CardGroupProps`, `CardLogo`, `CardProps`, `Separator`, `Skeleton` |
| `@kortix/ui` (forms) | `Input`, `inputFocusClasses`, `inputInvalidClasses`, `inputSurfaceClasses`, `inputTransitionClasses`, `InputProps`, `useAutosizeTextArea`, `Textarea`, `AutosizeTextAreaRef`, `AutosizeTextAreaProps`, `Label`, `Checkbox`, `CheckboxProps`, `CheckboxVariant`, `Switch`, `SwitchProps`, `Select`, `SelectContent`, `SelectGroup`, `SelectItem`, `SelectLabel`, `SelectScrollDownButton`, `SelectScrollUpButton`, `SelectSeparator`, `SelectTrigger`, `SelectValue`, `SelectTriggerProps` |
| `@kortix/ui` (overlays) | `Modal`, `ModalBody`, `ModalClose`, `ModalContent`, `ModalContentInner`, `ModalDescription`, `ModalFooter`, `ModalHeader`, `ModalOverlay`, `ModalPortal`, `ModalTitle`, `ModalTrigger`, `Hint`, `HintProps`, `Popover`, `PopoverAnchor`, `PopoverContent`, `PopoverTrigger`, `DropdownMenu`, `DropdownMenuCheckboxItem`, `DropdownMenuContent`, `DropdownMenuGroup`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuPortal`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubContent`, `DropdownMenuSubTrigger`, `DropdownMenuTrigger` |
| `@kortix/ui` (primitives, not for feature code: section 3) | `Dialog`, `DialogClose`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogOverlay`, `DialogPortal`, `DialogTitle`, `DialogTrigger`, `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger` |
| `@kortix/ui` (navigation) | `FilterBar`, `FilterBarItem`, `Tabs`, `TabsContent`, `TabsList`, `TabsListCompact`, `TabsTrigger`, `TabsTriggerCompact`, `tabsTriggerHeightVariants`, `tabsTriggerPaddingVariants`, `tabsTriggerTextVariants`, `TabsListType`, `TabsSize`, `TabsTriggerSize`, `TabsTriggerVariant`, `TabsUnderlineSize` |
| `@kortix/ui` (conversation) | `Bubble`, `BubbleContent`, `BubbleGroup`, `BubbleReactions`, `bubbleVariants`, `Message`, `MessageAvatar`, `MessageContent`, `MessageFooter`, `MessageGroup`, `MessageHeader`, `Marker`, `MarkerContent`, `MarkerIcon`, `markerVariants` |
| `@kortix/ui/chat` (whole thread) | `SessionThread`, `SessionThreadProps`, `SessionPickers`, `MessageList`, `DefaultEmptyState` |
| `@kortix/ui/chat` (one message) | `MessageView`, `MessageRenderers`, `RenderTool`, `ToolCall`, `Markdown`, `userMessageParts` |
| `@kortix/ui/chat` (input) | `Composer`, `ComposerCommand`, `parseCommand`, `slashQuery`, `ModelPicker`, `filterModels`, `AgentPicker` |
| `@kortix/ui/chat` (prompts, errors) | `PermissionPrompt`, `PermissionDecision`, `QuestionPrompt`, `ChatErrorHandler`, `sendFailureTitle` |
| `@kortix/ui/chat` (streaming) | `streamingMarkdown`, `holdBackFenceOpener`, `closeUnterminatedCodeFence`, `holdBackTableHeader` |

Every other component is one subpath per file: `@kortix/ui/<file name>` (`@kortix/ui/dot-matrix/<name>`
for the dot matrices), plus `@kortix/ui/lib/<name>`, `@kortix/ui/hooks/<name>` and `@kortix/ui/icons/<name>`.

## 8. Chat recipe

```tsx
import { useSession } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/chat';
import { errorToast } from '@kortix/ui/toast';

export function Chat({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const session = useSession(projectId, sessionId);
  return <div className="h-dvh"><SessionThread session={session} onError={(m) => errorToast(m)} /></div>;
}
```

- Needs `@tanstack/react-query` and one `QueryClientProvider`. The parent sets the height. Slots:
  `composerToolbar`, `composerFooter`, `emptyState`; `renderTool` (`undefined` keeps the default), `renderers`.
- A layout of your own composes `MessageList`, `MessageView`, `Composer` and the prompts from the same
  `useSession` result. Never write a second transport or a raw `fetch`.
- A fully custom transcript uses `renderParts` from `@kortix/sdk/react` (docs: /docs/sdk/react).

## 9. Verify

1. Types: `tsc --noEmit` in the host adds no error.
2. Run the page in a browser in light and dark, at 720 × 480 and at a phone width. Click every control.
3. Search your diff: no hex or `rgb(`, no `-[` spacing bracket, no `lucide-react`, no `toast(`, no
   `animate-spin`. Kortix-internal: `.agents/skills/kortix-brand/scripts/audit.sh <paths>` is clean.
4. White-label: change `--kortix-blue` and `--ring` in `:root`; a checked `Switch` and focus rings follow.

## 10. Kortix-internal work

In `kortix-ai/suna`, these skills are the law and win over this file:
- `kortix-brand` (values, voice, decisions): https://github.com/kortix-ai/suna/blob/dev/.agents/skills/kortix-brand/SKILL.md
- `kortix-design-system` (which component, reference screens): https://github.com/kortix-ai/suna/blob/dev/.agents/skills/kortix-design-system/SKILL.md
- `apps/web` imports keep their old paths (`@/components/ui/<name>`): those files are one-line shims.
  Edit the component in `packages/ui/src/components/ui/<name>.tsx`, never the shim.
