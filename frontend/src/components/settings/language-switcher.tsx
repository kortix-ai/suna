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
import { Globe } from 'lucide-react';
import { locales, type Locale } from '@/i18n/config';

const languageNames: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  it: 'Italiano',
};

export function LanguageSwitcher() {
  const { locale, setLanguage, availableLanguages } = useLanguage();

  return (
    <div className="space-y-2">
      <Label htmlFor="language-select" className="flex items-center gap-2">
        <Globe className="h-4 w-4" />
        Language
      </Label>
      <p className="text-sm text-muted-foreground">
        Choose your preferred language
      </p>
      <Select
        value={locale}
        onValueChange={(value) => setLanguage(value as Locale)}
      >
        <SelectTrigger id="language-select" className="w-full">
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
      <p className="text-xs text-muted-foreground">
        Current Language: {languageNames[locale as Locale] || locale}
      </p>
    </div>
  );
}

