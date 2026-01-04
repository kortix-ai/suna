'use client';

import { useLanguage } from '@/hooks/use-language';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
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

export function LanguageSwitcher() {
  const { locale, setLanguage, availableLanguages } = useLanguage();

  return (
    <div className="space-y-2">
      <Label htmlFor="language-select">
        Language
      </Label>
      <Select
        value={locale}
        onValueChange={(value) => setLanguage(value as Locale)}
      >
        <SelectTrigger id="language-select" className="w-full !h-11">
          <SelectValue>
            {languageNames[locale as Locale] || locale}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {availableLanguages.map((lang) => (
            <SelectItem key={lang} value={lang}>
              {languageNames[lang]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

