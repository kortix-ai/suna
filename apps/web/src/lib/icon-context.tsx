"use client";

import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";

import {
  ArrowCounterClockwiseIcon,
  ArrowElbowDownRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BellIcon,
  BooksIcon,
  BrainIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckIcon,
  CircleIcon,
  ClockIcon,
  CopyIcon,
  DotIcon,
  EnvelopeIcon,
  EyedropperIcon,
  GearIcon,
  GlobeIcon,
  HeartIcon,
  HouseIcon,
  ImageIcon,
  LightbulbIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  MagnifyingGlassIcon,
  MonitorIcon,
  MoonIcon,
  PaintBrushIcon,
  PaletteIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RectangleIcon,
  RocketIcon,
  ShieldIcon,
  SkipForwardIcon,
  StarIcon,
  SunIcon,
  TrayIcon,
  UserIcon,
  UsersIcon,
  XIcon,
  type IconProps,
} from "@phosphor-icons/react";

/**
 * Phosphor's own prop contract — `size`, `color`, `weight`, `mirrored`, plus
 * every `<svg>` attribute. Icons never take a `weight` here: the app-wide
 * constant reaches them through Phosphor's IconContext, which
 * `@/components/ui/icon-provider` installs at the root (see
 * `src/lib/icons/icon-config.ts`).
 *
 * Phosphor fills a solid path rather than stroking an outline, so `strokeWidth`
 * type-checks (it is a legal SVG attribute) but paints nothing.
 */
export type IconComponentProps = IconProps;

export type IconComponent = ComponentType<IconComponentProps>;

export type IconName =
  | "chevron-right" | "chevron-down" | "x" | "copy" | "menu" | "dot"
  | "monitor" | "sun" | "moon" | "rectangle-horizontal" | "circle"
  | "square-library" | "clock" | "star" | "settings"
  | "plus" | "arrow-left" | "arrow-right" | "arrow-up" | "search"
  | "users" | "lock" | "mail" | "bell" | "shield" | "palette"
  | "lightbulb" | "rocket" | "heart" | "paintbrush" | "brain"
  | "globe" | "user"
  | "image" | "link" | "check" | "rotate-ccw"
  | "play" | "pause" | "pipette"
  | "home" | "message-circle" | "inbox"
  | "pencil" | "skip-forward" | "corner-down-right";

/* There is deliberately no "loader" entry. `Loading`
   (@/components/ui/loading) is the codebase's only spinner, and no icon may
   stand in for it. */
export const defaultIcons: Record<IconName, IconComponent> = {
  "chevron-right": CaretRightIcon,
  "chevron-down": CaretDownIcon,
  "pipette": EyedropperIcon,
  "x": XIcon,
  "copy": CopyIcon,
  "menu": ListIcon,
  "dot": DotIcon,
  "monitor": MonitorIcon,
  "sun": SunIcon,
  "moon": MoonIcon,
  "rectangle-horizontal": RectangleIcon,
  "circle": CircleIcon,
  "square-library": BooksIcon,
  "clock": ClockIcon,
  "star": StarIcon,
  "settings": GearIcon,
  "plus": PlusIcon,
  "arrow-left": ArrowLeftIcon,
  "arrow-right": ArrowRightIcon,
  "arrow-up": ArrowUpIcon,
  "search": MagnifyingGlassIcon,
  "users": UsersIcon,
  "lock": LockIcon,
  "mail": EnvelopeIcon,
  "bell": BellIcon,
  "shield": ShieldIcon,
  "palette": PaletteIcon,
  "lightbulb": LightbulbIcon,
  "rocket": RocketIcon,
  "heart": HeartIcon,
  "paintbrush": PaintBrushIcon,
  "brain": BrainIcon,
  "globe": GlobeIcon,
  "user": UserIcon,
  "image": ImageIcon,
  "link": LinkIcon,
  "check": CheckIcon,
  "rotate-ccw": ArrowCounterClockwiseIcon,
  "play": PlayIcon,
  "pause": PauseIcon,
  "home": HouseIcon,
  "message-circle": ChatCircleIcon,
  "inbox": TrayIcon,
  "pencil": PencilIcon,
  "skip-forward": SkipForwardIcon,
  "corner-down-right": ArrowElbowDownRightIcon,
};

const IconContext = createContext<Record<IconName, IconComponent> | null>(null);

/**
 * Returns a single icon component for the given name.
 * Falls back to the default (Phosphor) set if no provider is present.
 */
function useIcon(name: IconName): IconComponent {
  const icons = useContext(IconContext);
  return (icons ?? defaultIcons)[name];
}

/**
 * Returns the full icon map.
 * Falls back to the default (Phosphor) set if no provider is present.
 */
function useIcons(): Record<IconName, IconComponent> {
  const icons = useContext(IconContext);
  return icons ?? defaultIcons;
}

/**
 * Swap some or all icons for components from another library.
 * Names left out of `icons` keep their default (Phosphor) component.
 */
function IconProvider({
  children,
  icons,
}: {
  children: ReactNode;
  icons?: Partial<Record<IconName, IconComponent>>;
}) {
  const value = useMemo(() => ({ ...defaultIcons, ...icons }), [icons]);
  return <IconContext.Provider value={value}>{children}</IconContext.Provider>;
}

export { IconProvider, useIcon, useIcons };
