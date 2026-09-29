'use client';

import {
  CaretDownIcon,
  EnvelopeIcon,
  GearIcon,
  KeyboardIcon,
  LinkIcon,
  TrashIcon,
  UserIcon,
  UserPlusIcon,
} from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { MenuRowSize } from '@/components/ui/menu-recipe';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE } from '@/components/ui/trigger-variants';
import { cn } from '@/lib/utils';

const SIZES: MenuRowSize[] = ['sm', 'md', 'lg'];

const SHORTCUT = { profile: '⇧⌘P', settings: '⌘,', shortcuts: '⌘/', delete: '⌘⌫' } as const;

function DemoRow({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground mb-3 text-xs">{caption}</p>
      <div className="flex flex-wrap items-start gap-6">{children}</div>
    </div>
  );
}

/** One demo with its row size named under it, so the three read as a scale. */
function Sized({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {children}
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

/** Only the ROW size changes between the demos; every trigger is the default. */
const ROWS_LABEL: Record<MenuRowSize, string> = {
  sm: 'Small rows (default)',
  md: 'Medium rows',
  lg: 'Large rows',
};

const FRAMEWORKS = [
  { value: 'next', label: 'Next.js' },
  { value: 'remix', label: 'Remix' },
  { value: 'astro', label: 'Astro' },
  { value: 'nuxt', label: 'Nuxt' },
];

export function SelectDemos() {
  return (
    <div className="space-y-8">
      <DemoRow caption="Item sizes">
        {SIZES.map((size) => (
          <Sized key={size} label={ROWS_LABEL[size]}>
            <Select defaultValue="next">
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FRAMEWORKS.map((framework) => (
                  <SelectItem key={framework.value} value={framework.value} size={size}>
                    {framework.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Sized>
        ))}
      </DemoRow>

      <DemoRow caption="Groups, descriptions and disabled">
        <Select defaultValue="django">
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="w-80">
            <SelectGroup>
              <SelectLabel>Frontend</SelectLabel>
              <SelectItem
                value="next"
                description="React with server components and file-based routing."
              >
                {FRAMEWORKS[0].label}
              </SelectItem>
              <SelectItem value="remix">{FRAMEWORKS[1].label}</SelectItem>
              <SelectItem value="astro">{FRAMEWORKS[2].label}</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Backend</SelectLabel>
              <SelectItem value="django" description="Batteries-included Python web framework.">
                Django
              </SelectItem>
              <SelectItem value="rails">Ruby on Rails</SelectItem>
              <SelectItem value="laravel">Laravel</SelectItem>
              <SelectItem value="phoenix" disabled>
                Phoenix (coming soon)
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </DemoRow>
    </div>
  );
}

/**
 * Every row type the dropdown has, at one size: an icon group with shortcuts,
 * checkbox rows, left radios, a submenu and a destructive row. Labels in every
 * row type start on the same x — that is what this demo exists to show.
 */
function AdvancedMenuContent({ size }: { size: MenuRowSize }) {
  const [sidebar, setSidebar] = useState(true);
  const [minimap, setMinimap] = useState(false);
  const [theme, setTheme] = useState('system');

  return (
    <DropdownMenuContent align="start" className="w-64">
      <DropdownMenuLabel>My account</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuItem size={size}>
          <UserIcon />
          Profile
          <DropdownMenuShortcut>{SHORTCUT.profile}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem size={size}>
          <GearIcon />
          Settings
          <DropdownMenuShortcut>{SHORTCUT.settings}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem size={size}>
          <KeyboardIcon />
          Keyboard shortcuts
          <DropdownMenuShortcut>{SHORTCUT.shortcuts}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>View</DropdownMenuLabel>
      <DropdownMenuCheckboxItem size={size} checked={sidebar} onCheckedChange={setSidebar}>
        Show sidebar
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem size={size} checked={minimap} onCheckedChange={setMinimap}>
        Show minimap
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem size={size} checked disabled>
        Show status bar
      </DropdownMenuCheckboxItem>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
        <DropdownMenuRadioItem size={size} side="left" value="light">
          Light
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem size={size} side="left" value="dark">
          Dark
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem size={size} side="left" value="system">
          System
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>

      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger size={size}>
          <UserPlusIcon />
          Invite people
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuItem size={size}>
            <EnvelopeIcon />
            Email
          </DropdownMenuItem>
          <DropdownMenuItem size={size}>
            <LinkIcon />
            Copy link
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem size={size} inset>
            More options
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSeparator />
      <DropdownMenuItem size={size} variant="destructive">
        <TrashIcon />
        Delete project
        <DropdownMenuShortcut>{SHORTCUT.delete}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export function DropdownDemos() {
  return (
    <div className="space-y-8">
      <DemoRow caption="Item sizes">
        {SIZES.map((size) => (
          <Sized key={size} label={ROWS_LABEL[size]}>
            <DropdownMenu>
              <DropdownMenuTrigger className="w-48">
                <span>My account</span>
                <CaretDownIcon className={cn(TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE.sm)} />
              </DropdownMenuTrigger>
              <AdvancedMenuContent size={size} />
            </DropdownMenu>
          </Sized>
        ))}
      </DemoRow>
      <p className="text-muted-foreground text-xs">
        The same menu at every row size: icons, shortcuts, checkboxes, radios, a submenu and a
        destructive row.
      </p>
    </div>
  );
}
