// @kortix/ui root barrel: light core primitives only (Radix, cva, motion).
// Heavy or app-shaped modules are reachable only through their own subpath,
// never from here: charts ('@kortix/ui/chart'), maps ('@kortix/ui/map'), grids
// ('@kortix/ui/data-grid'), mermaid, emoji data ('@kortix/ui/emoji-picker'),
// toasts ('@kortix/ui/toast', sonner) and the session UI ('@kortix/ui/session').
// Names are explicit (no `export *`): src/skill.test.ts checks that the
// kortix-ui skill lists every one.
export { cn } from './lib/utils';
export {
  UiProvider,
  defaultUiHostConfig,
  defaultUiNavigation,
  defaultUiStrings,
  useUiBrand,
  useUiHostConfig,
  useUiImage,
  useUiLink,
  useUiParams,
  useUiPathname,
  useUiRouter,
  useUiShallowNavigate,
  useUiSearchParams,
  useUiStrings,
  useUiViewerId,
  type UiBrand,
  type UiHostConfig,
  type UiImageComponent,
  type UiImageProps,
  type UiLinkComponent,
  type UiLinkProps,
  type UiNavigation,
  type UiRouteParams,
  type UiRouter,
  type UiSearchParams,
  type UiShallowNavigate,
  type UiSlashAction,
  type UiStrings,
  type UiStringsInput,
  type UseUiBrand,
} from './providers/ui-provider';
export { SessionIdsProvider, useSessionIds, type UiSessionIds } from './providers/session-ids';
export { useIsDark } from './hooks/use-is-dark';
export {
  Button,
  buttonVariants,
  type ButtonProps,
} from './primitives/button';
export {
  Badge,
  badgeVariants,
} from './primitives/badge';
export {
  Card,
  CardAction,
  CardButton,
  CardContent,
  CardDescription,
  CardEyebrow,
  CardFeature,
  CardFooter,
  CardGroup,
  CardHeader,
  CardImage,
  CardMedia,
  CardTitle,
  type CardButtonProps,
  type CardButtonSize,
  type CardButtonVariant,
  type CardGroupProps,
  type CardLogo,
  type CardProps,
} from './primitives/card';
export {
  Separator,
} from './primitives/separator';
export {
  Skeleton,
} from './primitives/skeleton';
export {
  Input,
  inputFocusClasses,
  inputInvalidClasses,
  inputSurfaceClasses,
  inputTransitionClasses,
  type InputProps,
} from './primitives/input';
export {
  useAutosizeTextArea,
  Textarea,
  type AutosizeTextAreaRef,
  type AutosizeTextAreaProps,
} from './primitives/textarea';
export {
  Label,
} from './primitives/label';
export {
  Checkbox,
  type CheckboxProps,
  type CheckboxVariant,
} from './primitives/checkbox';
export {
  Switch,
  type SwitchProps,
} from './primitives/switch';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  type SelectTriggerProps,
} from './primitives/select';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './primitives/dialog';
export {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalContentInner,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  ModalPortal,
  ModalTitle,
  ModalTrigger,
} from './primitives/modal';
export { Hint, type HintProps } from './primitives/hint';
// Dialog and Tooltip are the primitives Modal and Hint build on. Feature code
// uses Modal and Hint (the kortix-ui skill, section 3); both carry @deprecated.
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from './primitives/popover';
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './primitives/tooltip';
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './primitives/dropdown-menu';
export {
  FilterBar,
  FilterBarItem,
  Tabs,
  TabsContent,
  TabsList,
  TabsListCompact,
  TabsTrigger,
  TabsTriggerCompact,
  tabsTriggerHeightVariants,
  tabsTriggerPaddingVariants,
  tabsTriggerTextVariants,
  type TabsListType,
  type TabsSize,
  type TabsTriggerSize,
  type TabsTriggerVariant,
  type TabsUnderlineSize,
} from './primitives/tabs';
export {
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
  bubbleVariants,
} from './primitives/bubble';
export {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from './primitives/message';
export {
  Marker,
  MarkerContent,
  MarkerIcon,
  markerVariants,
} from './primitives/marker';
export { useDebounce } from './hooks/use-debounce';
export { useIsMobile } from './hooks/use-mobile';
export { useMediaQuery } from './internal/hooks/use-media-query';
export { useSlashFocus } from './internal/hooks/use-slash-focus';
export { faviconUrlForHostname } from './lib/favicon';
export { setUiHostEnv } from './lib/host-env';
export { decodeSpaceSegment, defaultUiRoutes, setUiRoutes, uiRoutes, type UiRoutes } from './lib/routes';
export { DEFAULT_ICON_WEIGHT, ICON_WEIGHTS, SHIPPED_ICON_WEIGHTS } from './lib/icon-config';
export { lazyClient } from './lib/lazy-client';
export { spring } from './lib/springs';
export { setUiTelemetry } from './lib/telemetry';
export {
  dialogContentZ,
  dialogOverlayZ,
  floatingZ,
  hasOpenFloatingLayer,
  hasOpenNestedDialog,
  useDialogDepth,
} from './lib/z-stack';
export {
  UiImage,
  UiLink,
  useUiViewer,
  type UiHostComponents,
  type UiPreviewRequest,
  type UiPreviewUrlResolver,
  type UiViewer,
} from './providers/ui-provider';
