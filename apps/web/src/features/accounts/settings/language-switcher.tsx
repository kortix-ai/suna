'use client';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLanguage } from '@/hooks/use-language';
import { localeNames, type Locale } from '@/i18n/config';
import { useTranslations } from '@/i18n/use-translations';

export function LanguageSwitcher() {
  const { locale, setLanguage, availableLanguages } = useLanguage();
  const t = useTranslations('settings.general.language');

  return (
    <div className="space-y-2">
      <Label htmlFor="language-select">{t('title')}</Label>
      <Select value={locale} onValueChange={(value) => setLanguage(value as Locale)}>
        <SelectTrigger id="language-select" className="!h-11 w-full">
          <SelectValue>{localeNames[locale as Locale] || locale}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {availableLanguages.map((lang) => (
            <SelectItem key={lang} value={lang}>
              {localeNames[lang]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
