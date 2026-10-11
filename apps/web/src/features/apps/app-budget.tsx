'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { successToast } from '@/components/ui/toast';

import { useTranslations } from '@/i18n/use-translations';

import { type App } from '@kortix/sdk';
import { useProjectApps } from '@kortix/sdk/react';

import { useState } from 'react';

/** The API ceiling for `monthly_budget_usd` (apps/api/src/apps/routes.ts). */
const MAX_BUDGET_USD = 100_000;

/**
 * Edit an on-demand server App's monthly compute budget: it stops at the
 * budget. Always-on and Convex Apps have a fixed cost and no budget.
 */
export function AppBudgetModal({
  projectId,
  app,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const apps = useProjectApps(projectId);
  const [value, setValue] = useState(String(app.monthly_budget_usd ?? ''));
  const budget = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(budget) && budget >= 0 && budget <= MAX_BUDGET_USD;

  const save = async () => {
    try {
      await apps.update.mutateAsync({ appId: app.app_id, input: { monthly_budget_usd: budget } });
      successToast(tI18nComplete.raw('textad954fb2accd'));
      onOpenChange(false);
    } catch {
      // Failure is already toasted by the query client's global mutations.onError.
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => !apps.update.isPending && onOpenChange(next)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('textc247593b2c0f')}</ModalTitle>
          <ModalDescription>
            {tI18nComplete.raw('texted76c66b7a8d')}
          </ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Field>
            <FieldLabel htmlFor="app-monthly-budget">{tI18nComplete.raw('text4972b5f3b4f5')}</FieldLabel>
            <Input
              id="app-monthly-budget"
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_BUDGET_USD}
              step={1}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && valid) void save();
              }}
            />
          </Field>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)} disabled={apps.update.isPending}>
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
          <Button size="sm" onClick={save} disabled={!valid || apps.update.isPending}>
            {apps.update.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {tI18nComplete.raw('text1509f561f241')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
