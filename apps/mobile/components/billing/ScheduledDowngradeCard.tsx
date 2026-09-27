/**
 * Scheduled plan change on the Billing page.
 *
 * A settings group (apps/mobile/design.md): the new plan, the date it starts,
 * and Keep current plan. Keep current plan confirms in an AlertDialog and
 * cancels the scheduled change; a failure stays in the dialog.
 */

import * as React from 'react';
import { ArrowsLeftRightIcon as ArrowRightLeft, CalendarDotsIcon as CalendarClock, ArrowUUpLeftIcon as Undo2 } from '@/lib/icons';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useLanguage } from '@/contexts';
import { useCancelScheduledChange } from '@/lib/billing';
import { haptics } from '@/lib/haptics';

export interface ScheduledPlanChange {
  type?: 'upgrade' | 'downgrade' | 'change';
  current_tier: { name: string; display_name: string; monthly_credits?: number };
  target_tier: { name: string; display_name: string; monthly_credits?: number };
  effective_date: string;
}

interface ScheduledDowngradeCardProps {
  scheduledChange: ScheduledPlanChange;
  /** Runs after the scheduled change is cancelled. */
  onCancel?: () => void;
}

export function ScheduledDowngradeCard({ scheduledChange, onCancel }: ScheduledDowngradeCardProps) {
  const { t } = useLanguage();
  const cancelChange = useCancelScheduledChange();
  const [open, setOpen] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const currentPlan =
    scheduledChange.current_tier.display_name || scheduledChange.current_tier.name;
  const targetPlan = scheduledChange.target_tier.display_name || scheduledChange.target_tier.name;
  const date = new Date(scheduledChange.effective_date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const keepPlan = () => {
    haptics.medium();
    setFailed(false);
    cancelChange.mutate(undefined, {
      onSuccess: () => {
        haptics.success();
        setOpen(false);
        onCancel?.();
      },
      onError: () => {
        haptics.warning();
        setFailed(true);
      },
    });
  };

  return (
    <>
      <SettingsGroup title={t('billing.scheduledChange', 'Scheduled change')}>
        <SettingsRow
          icon={ArrowRightLeft}
          label={t('billing.newPlan', 'New plan')}
          value={targetPlan}
        />
        <SettingsRow icon={CalendarClock} label={t('billing.startsOn', 'Starts on')} value={date} />
        <SettingsRow
          icon={Undo2}
          label={t('billing.keepCurrentPlan', 'Keep current plan')}
          onPress={() => {
            haptics.tap();
            setFailed(false);
            setOpen(true);
          }}
        />
      </SettingsGroup>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          // Keep the dialog up until an in-flight cancel settles.
          if (!cancelChange.isPending) setOpen(next);
        }}>
        <AlertDialogContent className="rounded-3xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('billing.keepPlanTitle', { defaultValue: 'Keep {{plan}}?', plan: currentPlan })}
            </AlertDialogTitle>
            <AlertDialogDescription className={failed ? 'text-destructive' : undefined}>
              {failed
                ? t('billing.keepPlanFailed', 'Could not cancel the change. Try again.')
                : t('billing.keepPlanDescription', {
                    defaultValue: 'The change to {{plan}} on {{date}} is cancelled.',
                    plan: targetPlan,
                    date,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild disabled={cancelChange.isPending}>
              <Button variant="secondary" size="lg" className="rounded-full">
                <Text>{t('common.cancel', 'Cancel')}</Text>
              </Button>
            </AlertDialogCancel>
            <Button
              size="lg"
              className="rounded-full"
              disabled={cancelChange.isPending}
              onPress={keepPlan}>
              <Text>
                {cancelChange.isPending
                  ? t('billing.keepingPlan', 'Keeping plan…')
                  : t('billing.keepPlan', 'Keep plan')}
              </Text>
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
