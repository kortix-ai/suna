'use client';

import { useTranslations } from 'next-intl';
/**
 * Custom frontend-URL prompt for the desktop app (self-hosting).
 *
 * This has NO visible entry point of its own. It only opens when the hidden
 * native menu item (Kortix → Frontend URL → "Custom URL…") fires the
 * `kortix-open-frontend-url` DOM event — native menus can't take text input, so
 * this tiny dialog is the text-entry surface. The value is persisted locally by
 * the Tauri shell and the window reloads onto it. Renders nothing on the web.
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getFrontendUrl, isDesktop, setFrontendUrl } from '@/lib/desktop';
import { toast } from '@/lib/toast';
import { useEffect, useState } from 'react';

export function DesktopUrlPrompt() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    const onOpen = () => {
      getFrontendUrl().then((u) => {
        setValue(u ?? '');
        setOpen(true);
      });
    };
    window.addEventListener('kortix-open-frontend-url', onOpen);
    return () => window.removeEventListener('kortix-open-frontend-url', onOpen);
  }, []);

  const apply = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await setFrontendUrl(trimmed);
      // The native command reloads the window onto the new URL.
    } catch (e) {
      // Tauri rejects commands with a plain string, not an Error — surface it.
      const msg =
        typeof e === 'string' ? e : e instanceof Error ? e.message : 'Could not set frontend URL';
      toast.error(msg);
      setBusy(false);
    }
  };

  if (!isDesktop()) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {tI18nHardcoded.raw(
              'autoComponentsDesktopDesktopUrlPromptJsxTextCustomFrontendURL8006a906',
            )}
          </DialogTitle>
          <DialogDescription>
            {tI18nHardcoded.raw(
              'autoComponentsDesktopDesktopUrlPromptJsxTextPointThisDesktop4b4ff15f',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="desktop-custom-frontend-url">URL</Label>
          <Input
            id="desktop-custom-frontend-url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://kortix.your-company.com/projects"
            disabled={busy}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
            className="shadow-none"
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={apply} disabled={busy || !value.trim()}>
            {tI18nHardcoded.raw('autoComponentsDesktopDesktopUrlPromptJsxTextApplyReload0eff0716')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
