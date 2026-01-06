'use client';

import { useLanguage } from '@/hooks/use-language';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Globe } from 'lucide-react';
import { locales, type Locale } from '@/i18n/config';

const languageNames: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  it: 'Italiano',
  zh: '中文',
  ja: '日本語',
  pt: 'Português',
  fr: 'Français',
  es: 'Español',
};

const languageCodes: Record<Locale, string> = {
  en: 'EN',
  de: 'DE',
  it: 'IT',
  zh: 'ZH',
  ja: 'JA',
  pt: 'PT',
  fr: 'FR',
  es: 'ES',
};

interface LocaleSwitcherProps {
  variant?: 'compact' | 'full';
}

export function LocaleSwitcher({ variant = 'compact' }: LocaleSwitcherProps) {
  const { locale, setLanguage, availableLanguages } = useLanguage();

  if (variant === 'compact') {
    return (
      <Select
        value={locale}
        onValueChange={(value) => setLanguage(value as Locale)}
      >
        <SelectTrigger 
          size="sm"
          className="h-7 px-2.5 w-fit min-w-[60px] border-0 bg-transparent hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 text-muted-foreground/60 transition-all duration-200 shadow-none"
        >
          <div className="flex items-center gap-1.5">
            <Globe className="size-3.5" />
            <SelectValue>
              {languageCodes[locale as Locale] || locale.toUpperCase()}
            </SelectValue>
          </div>
        </SelectTrigger>
        <SelectContent>
          {availableLanguages.map((lang) => (
            <SelectItem key={lang} value={lang}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{languageCodes[lang]}</span>
                <span className="text-muted-foreground">{languageNames[lang]}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  return (
    <Select
      value={locale}
      onValueChange={(value) => setLanguage(value as Locale)}
    >
      <SelectTrigger 
        size="sm"
        className="h-9 w-full min-w-0 border border-border bg-accent/50 hover:bg-accent dark:hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-all duration-200 shadow-none"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Globe className="size-3.5 shrink-0" />
          <SelectValue className="truncate">
            {languageNames[locale as Locale] || locale}
          </SelectValue>
        </div>
      </SelectTrigger>
      <SelectContent>
        {availableLanguages.map((lang) => (
          <SelectItem key={lang} value={lang}>
            <div className="flex items-center gap-2">
              <span className="font-medium">{languageCodes[lang]}</span>
              <span className="text-muted-foreground">{languageNames[lang]}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

