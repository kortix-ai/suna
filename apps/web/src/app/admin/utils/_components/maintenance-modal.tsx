'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import type { MaintenanceLevel } from '@/lib/maintenance-store';
import { cn } from '@/lib/utils';

import { AVAILABLE_SERVICES, MAINTENANCE_LEVELS, MAINTENANCE_TONE_GLYPH } from './constants';
import { DateTimePicker } from './date-time-picker';

interface MaintenanceConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  level: MaintenanceLevel;
  title: string;
  setTitle: (title: string) => void;
  message: string;
  setMessage: (message: string) => void;
  startDate: Date | undefined;
  setStartDate: (date: Date | undefined) => void;
  endDate: Date | undefined;
  setEndDate: (date: Date | undefined) => void;
  statusUrl: string;
  setStatusUrl: (url: string) => void;
  services: string[];
  toggleService: (service: string) => void;
  onSave: () => Promise<void>;
  isPending: boolean;
}

/**
 * The configure step for one notification level.
 *
 * `Modal`, not `Dialog` — feature code composes `modal.tsx`
 * (`kortix-design-system` → *Required primitives*), which brings the header,
 * body and footer rhythm with it instead of the hand-built `px-6` /
 * `bg-muted/30` chrome this replaces.
 */
export function MaintenanceConfigModal({
  open,
  onOpenChange,
  level,
  title,
  setTitle,
  message,
  setMessage,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  statusUrl,
  setStatusUrl,
  services,
  toggleService,
  onSave,
  isPending,
}: MaintenanceConfigModalProps) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const levelConfig = MAINTENANCE_LEVELS.find((l) => l.value === level);
  const Icon = levelConfig?.icon;
  const isNone = level === 'none';

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle className="flex items-center gap-2">
            {Icon && (
              <Icon
                weight="fill"
                className={cn(
                  'size-4 shrink-0',
                  MAINTENANCE_TONE_GLYPH[levelConfig?.tone ?? 'neutral'],
                )}
              />
            )}
            {tI18nComplete.raw('text6defafa2caa6')}
            {levelConfig?.label.toLowerCase() ?? 'maintenance'}
          </ModalTitle>
          <ModalDescription>
            {isNone
              ? tI18nComplete.raw('text21e4c72a597b')
              : tI18nComplete('textbdbdc3e6773d', {
                  value0: levelConfig?.label.toLowerCase() ?? 'maintenance',
                })}
          </ModalDescription>
        </ModalHeader>

        {!isNone && (
          <ModalBody className="max-h-[60vh] overflow-y-auto">
            <FieldGroup className="space-y-4">
              <Field>
                <FieldLabel htmlFor="m-title">{tI18nComplete.raw('text7e8cd2056da7')}</FieldLabel>
                <Input
                  id="m-title"
                  placeholder={levelConfig?.label ?? 'Maintenance'}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="m-message">{tI18nComplete.raw('text2f77668a9dfb')}</FieldLabel>
                <Textarea
                  id="m-message"
                  placeholder={tI18nComplete.raw('text94e0d14dbf98')}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                />
              </Field>

              {(level === 'warning' || level === 'blocking') && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <DateTimePicker
                    label={tI18nComplete.raw('textbabe9dda8503')}
                    date={startDate}
                    setDate={setStartDate}
                  />
                  <DateTimePicker
                    label={tI18nComplete.raw('text2e46006a5eeb')}
                    date={endDate}
                    setDate={setEndDate}
                  />
                </div>
              )}

              {(level === 'critical' || level === 'blocking') && (
                <Field>
                  <FieldLabel>{tI18nComplete.raw('textdc6c9309c03e')}</FieldLabel>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {AVAILABLE_SERVICES.map((service) => {
                      const SvcIcon = service.icon;
                      const isSelected = services.includes(service.label);
                      return (
                        <label
                          key={service.id}
                          className={cn(
                            'bg-popover flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm',
                            'duration-fast transition-colors ease-out',
                            isSelected ? 'bg-active' : 'hover:bg-hover',
                          )}
                        >
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleService(service.label)}
                          />
                          <SvcIcon className="text-muted-foreground size-3.5 shrink-0" />
                          <span className="truncate">{service.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </Field>
              )}

              <Field>
                <FieldLabel htmlFor="m-status-url">
                  {tI18nComplete.raw('text0d52d18febbd')}
                </FieldLabel>
                <Input
                  id="m-status-url"
                  placeholder="https://status.kortix.com"
                  value={statusUrl}
                  onChange={(e) => setStatusUrl(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </ModalBody>
        )}

        <ModalFooter className="sm:justify-between">
          <Button variant="outline-ghost" onClick={() => onOpenChange(false)}>
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
          <Button
            onClick={onSave}
            disabled={isPending || (!isNone && !message)}
            variant={level === 'blocking' || level === 'critical' ? 'destructive' : 'default'}
            className="gap-1.5"
          >
            {isPending ? <Loading className="size-4 shrink-0" /> : null}
            {isNone ? tI18nComplete.raw('texte6f312c6b6ef') : tI18nComplete.raw('text24433c70eba5')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
