---
name: kortix-ui
description: "Build React UI with @kortix/ui, the Kortix component library: Kortix Apps, white-label hosts, SDK customer apps and apps/web. Load before you write a component, a page, a chat view, a custom dashboard or App on @kortix/sdk, or a className in a React host that renders Kortix UI, or when you theme Kortix components for another brand. Covers setup, which component to compose, banned primitives, tokens, status tones, the SessionThread chat recipe, the dashboard guide, white-label theming and the verify steps."
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
   `UiProvider` (`strings`, `chat` included; `link` and `image`: your router's link and image; `useBrand`:
   an organization's logo; `navigation`, `i18n`, `useViewerId`, `config`: router hooks, translation hooks,
   user id, flags; README "Host adapters" lists each default), `SessionIdsProvider` around each session view (`projectId`, `sessionId`: read with `useSessionIds`, never route params), `IconProvider` (`@kortix/ui/icon-provider`, the house icon weight; not the icon-set provider of `lib/icon-context`) and one `<Toaster />` from `@kortix/ui/toast`. `setUiTelemetry` (`@kortix/ui/lib/telemetry`) once at module load.
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

Theme with `@kortix/ui/theme`, never by forking a component: `themeToCss(theme)` in a server `<style>` for the app, `<ThemeScope theme>` for one subtree (its overlays portal into it). `KortixTheme` is typed, every field optional:
`light` / `dark` colors (`blue` the accent: checked controls, `brand` `Button`, info tone; `ring` focus, sidebar ring follows; `foreground` / `background` page and default `Button`; `primary` ink for `Progress`, `Slider`, menu tint; `border`; any `--custom`),
`radius` (every `rounded-*` derives from it), `fonts.sans` / `fonts.mono`, `spacing` (density), `text`, `shadows` (`0 0 #0000` flattens), `durations`, `easing`, `vars`. Plain CSS also works: the same variables in `:root` / `.dark`.
Pass the organization's marks to `UiProvider useBrand`. Never load `fonts.css` (Roobert is Kortix-only), never edit a generated file.

## 7. Components

| Import from | Names |
| --- | --- |
| `@kortix/ui` (adapters) | `cn`, `UiProvider`, `defaultUiStrings`, `defaultChatStrings`, `useUiStrings`, `useUiLink`, `useUiImage`, `useUiBrand`, `UiStrings`, `UiStringsInput`, `ChatStrings`, `UiLinkProps`, `UiLinkComponent`, `UiImageProps`, `UiImageComponent`, `UiBrand`, `UseUiBrand`, `useIsDark`, `useUiRouter`, `useUiPathname`, `useUiSearchParams`, `useUiParams`, `defaultUiNavigation`, `UiNavigation`, `UiRouter`, `UiRouteParams`, `UiSearchParams`, `useUiViewerId`, `useUiHostConfig`, `defaultUiHostConfig`, `UiHostConfig`, `SessionIdsProvider`, `useSessionIds`, `UiSessionIds` |
| `@kortix/ui` (actions, display) | `Button`, `buttonVariants`, `ButtonProps`, `Badge`, `badgeVariants`, `Card`, `CardAction`, `CardButton`, `CardContent`, `CardDescription`, `CardEyebrow`, `CardFeature`, `CardFooter`, `CardGroup`, `CardHeader`, `CardImage`, `CardMedia`, `CardTitle`, `CardButtonProps`, `CardButtonSize`, `CardButtonVariant`, `CardGroupProps`, `CardLogo`, `CardProps`, `Separator`, `Skeleton` |
| `@kortix/ui` (forms) | `Input`, `inputFocusClasses`, `inputInvalidClasses`, `inputSurfaceClasses`, `inputTransitionClasses`, `InputProps`, `useAutosizeTextArea`, `Textarea`, `AutosizeTextAreaRef`, `AutosizeTextAreaProps`, `Label`, `Checkbox`, `CheckboxProps`, `CheckboxVariant`, `Switch`, `SwitchProps`, `Select`, `SelectContent`, `SelectGroup`, `SelectItem`, `SelectLabel`, `SelectScrollDownButton`, `SelectScrollUpButton`, `SelectSeparator`, `SelectTrigger`, `SelectValue`, `SelectTriggerProps` |
| `@kortix/ui` (overlays) | `Modal`, `ModalBody`, `ModalClose`, `ModalContent`, `ModalContentInner`, `ModalDescription`, `ModalFooter`, `ModalHeader`, `ModalOverlay`, `ModalPortal`, `ModalTitle`, `ModalTrigger`, `Hint`, `HintProps`, `Popover`, `PopoverAnchor`, `PopoverContent`, `PopoverTrigger`, `DropdownMenu`, `DropdownMenuCheckboxItem`, `DropdownMenuContent`, `DropdownMenuGroup`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuPortal`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubContent`, `DropdownMenuSubTrigger`, `DropdownMenuTrigger` |
| `@kortix/ui` (primitives, not for feature code: section 3) | `Dialog`, `DialogClose`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogOverlay`, `DialogPortal`, `DialogTitle`, `DialogTrigger`, `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger` |
| `@kortix/ui` (navigation) | `FilterBar`, `FilterBarItem`, `Tabs`, `TabsContent`, `TabsList`, `TabsListCompact`, `TabsTrigger`, `TabsTriggerCompact`, `tabsTriggerHeightVariants`, `tabsTriggerPaddingVariants`, `tabsTriggerTextVariants`, `TabsListType`, `TabsSize`, `TabsTriggerSize`, `TabsTriggerVariant`, `TabsUnderlineSize` |
| `@kortix/ui` (conversation) | `Bubble`, `BubbleContent`, `BubbleGroup`, `BubbleReactions`, `bubbleVariants`, `Message`, `MessageAvatar`, `MessageContent`, `MessageFooter`, `MessageGroup`, `MessageHeader`, `Marker`, `MarkerContent`, `MarkerIcon`, `markerVariants` |
| `@kortix/ui` (hooks, helpers) | `UiLink`, `UiImage`, `useUiViewer`, `UiViewer`, `UiHostComponents`, `useDebounce`, `useIsMobile`, `useMediaQuery`, `useSlashFocus`, `lazyClient`, `spring`, `floatingZ`, `dialogContentZ`, `dialogOverlayZ`, `useDialogDepth`, `hasOpenFloatingLayer`, `hasOpenNestedDialog`, `DEFAULT_ICON_WEIGHT`, `ICON_WEIGHTS`, `SHIPPED_ICON_WEIGHTS`, `faviconUrlForHostname`, `setUiTelemetry`, `setUiHostEnv` |
| `@kortix/ui/theme` | `KortixTheme`, `themeToCss`, `themeToCssVars`, `ThemeScope`, `ThemeScopeProps`, `THEME_COLOR_VARS`, `ThemeColor`, `ThemeColors`, `ThemeCssVars`, `ThemeTextStep`, `ThemeShadowStep`, `ThemeDurationStep`, `ThemeEasing`, `WALLPAPERS`, `DEFAULT_WALLPAPER_ID`, `getWallpaperById`, `Wallpaper` |
| `@kortix/ui/session` (whole thread) | `SessionThread`, `SessionThreadProps` |
| `@kortix/ui/session` (blocks) | `UserMessage`, `ThrottledMarkdown`, `UnifiedMarkdown`, `UnifiedMarkdownProps`, `ToolPartRenderer`, `SessionChatInput`, `SessionChatInputProps`, `AgentSelector`, `ModelSelector`, `ModelSelectorProps`, `SessionPermissionPrompt`, `QuestionPrompt`, `QuestionPromptHandle`, `TurnErrorDisplay`, `SessionBusyIndicator`, `SessionStartingLoader` |
| `@kortix/ui/session` (tool rows, pickers) | `ToolRegistry`, `ToolProps`, `ToolComponent`, `BasicTool`, `BasicToolProps`, `GenericTool`; for a form outside a session: `ModelPicker`, `filterModels`, `AgentPicker` |

Every other primitive is one subpath per file: `@kortix/ui/<file name>` (`@kortix/ui/dot-matrix/<name>` for the dot matrices).
Each module has one entry; `references/modules.md` lists every export and what to mount it in: `@kortix/ui/session`, `@kortix/ui/composer`, `@kortix/ui/session-panel`, `@kortix/ui/workspace`, `@kortix/ui/files`, `@kortix/ui/file-viewer`, `@kortix/ui/markdown`, `@kortix/ui/genui`, `@kortix/ui/diff`, `@kortix/ui/changes`, `@kortix/ui/terminal`, `@kortix/ui/browser`, `@kortix/ui/apps`, `@kortix/ui/access`, `@kortix/ui/customize`, `@kortix/ui/icons`, `@kortix/ui/theme`, `@kortix/ui/i18n` (`useTranslations`, `useLocale`: next-intl signatures over `UiProvider i18n` or the bundled English catalog).
A deep path (`@kortix/ui/<module>/<path>`) has no semver and exists only for the files in `scripts/deep-exports.json`; a host imports the entry. Also: `lib/telemetry` (`UiTelemetryRegister`: declaration-merge `event`), `error-boundary` (`ErrorBoundary`, `ErrorBoundaryFallback`).

## 8. Chat recipe

```tsx
import { useSession } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/session';

export function Chat({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <div className="h-dvh"><SessionThread session={useSession(projectId, sessionId)} hideHeader /></div>;
}
```

- It is the thread apps/web renders. Host needs: `QueryClientProvider`, `UiProvider`, `<Toaster />`. The parent sets the height.
  Install `@tanstack/react-query`, `@openuidev/lang-core@0.3.1` and `zod` with it: optional `@kortix/sdk` peers the thread needs.
- A custom tool row: `ToolRegistry.register('<tool name>', Row)`; `Row` gets `ToolProps`, draws `BasicTool`.
- A layout of your own composes the blocks above (`@kortix/ui/session-panel`, `@kortix/ui/workspace`) from the same `useSession` result. Never a raw `fetch`.
- A whole dashboard or App (install, client, providers, theme, project and session lists, embedded thread, custom tool row, App sign-in): `references/custom-dashboard.md`. Every sample in it compiles.

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
- `apps/web` imports `@kortix/ui/<name>` and the entries directly; it keeps no re-export shims.
  Edit the component in `packages/ui/src/primitives/<name>.tsx`.
