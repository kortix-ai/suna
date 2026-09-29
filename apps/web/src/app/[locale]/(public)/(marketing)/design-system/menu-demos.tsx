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

import { useTranslations } from '@/i18n/use-translations';

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
  const t = useTranslations('hardcodedUi.i18nComplete');
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
              <SelectLabel>{t.raw('textaf48bcf0b951')}</SelectLabel>
              <SelectItem
                value="next"
                description={t.raw('textd19297f36620')}
              >
                {FRAMEWORKS[0].label}
              </SelectItem>
              <SelectItem value="remix">{FRAMEWORKS[1].label}</SelectItem>
              <SelectItem value="astro">{FRAMEWORKS[2].label}</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{t.raw('text2fb4019a35e4')}</SelectLabel>
              <SelectItem value="django" description={t.raw('text030637ad147a')}>
                Django
              </SelectItem>
              <SelectItem value="rails">Ruby on Rails</SelectItem>
              <SelectItem value="laravel">Laravel</SelectItem>
              <SelectItem value="phoenix" disabled>
                {t.raw('text21f231146e6c')}
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
  const t = useTranslations('hardcodedUi.i18nComplete');

  return (
    <DropdownMenuContent align="start" className="w-64">
      <DropdownMenuLabel>{t.raw('textb53181a4d853')}</DropdownMenuLabel>
      <DropdownMenuGroup>
        <DropdownMenuItem size={size}>
          <UserIcon />
          {t.raw('textd696a35bdd18')}
          <DropdownMenuShortcut>{SHORTCUT.profile}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem size={size}>
          <GearIcon />
          {t.raw('text74a883a037bc')}
          <DropdownMenuShortcut>{SHORTCUT.settings}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem size={size}>
          <KeyboardIcon />
          {t.raw('texte9bef0b0f3c2')}
          <DropdownMenuShortcut>{SHORTCUT.shortcuts}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t.raw('textdcc839a4015c')}</DropdownMenuLabel>
      <DropdownMenuCheckboxItem size={size} checked={sidebar} onCheckedChange={setSidebar}>
        {t.raw('text9e8197ce9e5f')}
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem size={size} checked={minimap} onCheckedChange={setMinimap}>
        {t.raw('text073549e7238a')}
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem size={size} checked disabled>
        {t.raw('texte9736daa7c32')}
      </DropdownMenuCheckboxItem>

      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t.raw('textefb52e7172b7')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
        <DropdownMenuRadioItem size={size} side="left" value="light">
          {t.raw('textdbcd5e7bb7a0')}
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem size={size} side="left" value="dark">
          {t.raw('text60acc53f13a5')}
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem size={size} side="left" value="system">
          {t.raw('text6725e7bbcd28')}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>

      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger size={size}>
          <UserPlusIcon />
          {t.raw('text27bf0f2d3f3f')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-48">
          <DropdownMenuItem size={size}>
            <EnvelopeIcon />
            {t.raw('text969ccbd3cf63')}
          </DropdownMenuItem>
          <DropdownMenuItem size={size}>
            <LinkIcon />
            {t.raw('textdbf362d4f210')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem size={size} inset>
            {t.raw('textbc79cdffbaa8')}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSeparator />
      <DropdownMenuItem size={size} variant="destructive">
        <TrashIcon />
        {t.raw('text9c0b617e79e9')}
        <DropdownMenuShortcut>{SHORTCUT.delete}</DropdownMenuShortcut>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

export function DropdownDemos() {
  const t = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="space-y-8">
      <DemoRow caption="Item sizes">
        {SIZES.map((size) => (
          <Sized key={size} label={ROWS_LABEL[size]}>
            <DropdownMenu>
              <DropdownMenuTrigger className="w-48">
                <span>{t.raw('textb53181a4d853')}</span>
                <CaretDownIcon className={cn(TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE.sm)} />
              </DropdownMenuTrigger>
              <AdvancedMenuContent size={size} />
            </DropdownMenu>
          </Sized>
        ))}
      </DemoRow>
      <p className="text-muted-foreground text-xs">
        {t.raw('text8aec60d8fca6')}
      </p>
    </div>
  );
}
