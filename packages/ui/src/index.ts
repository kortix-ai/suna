// @kortix/ui root barrel: light core primitives only (Radix, cva, motion).
// Heavy or app-shaped modules are reachable only through their own subpath,
// never from here: charts ('@kortix/ui/chart'), maps ('@kortix/ui/map'), grids
// ('@kortix/ui/data-grid'), mermaid, emoji data ('@kortix/ui/emoji-picker'),
// toasts ('@kortix/ui/toast', sonner) and the session UI ('@kortix/ui/chat').
// Names are explicit (no `export *`): src/skill.test.ts checks that the
// kortix-ui skill lists every one.
export { cn } from './lib/utils';
export {
  UiProvider,
  defaultChatStrings,
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
  type ChatStrings,
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
} from './components/ui/button';
export {
  Badge,
  badgeVariants,
} from './components/ui/badge';
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
} from './components/ui/card';
export {
  Separator,
} from './components/ui/separator';
export {
  Skeleton,
} from './components/ui/skeleton';
export {
  Input,
  inputFocusClasses,
  inputInvalidClasses,
  inputSurfaceClasses,
  inputTransitionClasses,
  type InputProps,
} from './components/ui/input';
export {
  useAutosizeTextArea,
  Textarea,
  type AutosizeTextAreaRef,
  type AutosizeTextAreaProps,
} from './components/ui/textarea';
export {
  Label,
} from './components/ui/label';
export {
  Checkbox,
  type CheckboxProps,
  type CheckboxVariant,
} from './components/ui/checkbox';
export {
  Switch,
  type SwitchProps,
} from './components/ui/switch';
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
} from './components/ui/select';
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
} from './components/ui/dialog';
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
} from './components/ui/modal';
export { Hint, type HintProps } from './components/ui/hint';
// Dialog and Tooltip are the primitives Modal and Hint build on. Feature code
// uses Modal and Hint (the kortix-ui skill, section 3); both carry @deprecated.
export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from './components/ui/popover';
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui/tooltip';
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
} from './components/ui/dropdown-menu';
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
} from './components/ui/tabs';
export {
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
  bubbleVariants,
} from './components/ui/bubble';
export {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from './components/ui/message';
export {
  Marker,
  MarkerContent,
  MarkerIcon,
  markerVariants,
} from './components/ui/marker';
