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
import type { Locale } from '@/i18n/config';
import { useTranslations } from 'next-intl';

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
  const t = useTranslations('settings.general.language');

  return (
    <div className="space-y-2">
      <Label htmlFor="language-select">
        {t('title')}
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
