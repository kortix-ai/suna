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
import type { MaintenanceLevel } from '@/lib/maintenance-store';
import { cn } from '@/lib/utils';

import {
  AVAILABLE_SERVICES,
  MAINTENANCE_LEVELS,
  MAINTENANCE_TONE_GLYPH,
} from './constants';
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
            Configure {levelConfig?.label.toLowerCase() ?? 'maintenance'}
          </ModalTitle>
          <ModalDescription>
            {isNone
              ? 'Saving clears every active maintenance notification and restores normal access.'
              : `What everyone sees while the ${levelConfig?.label.toLowerCase()} is active.`}
          </ModalDescription>
        </ModalHeader>

        {!isNone && (
          <ModalBody className="max-h-[60vh] overflow-y-auto">
            <FieldGroup className="space-y-4">
              <Field>
                <FieldLabel htmlFor="m-title">Title</FieldLabel>
                <Input
                  id="m-title"
                  placeholder={levelConfig?.label ?? 'Maintenance'}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="m-message">Message</FieldLabel>
                <Textarea
                  id="m-message"
                  placeholder="Describe what is happening and when it ends."
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                />
              </Field>

              {(level === 'warning' || level === 'blocking') && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <DateTimePicker label="Start time" date={startDate} setDate={setStartDate} />
                  <DateTimePicker label="End time" date={endDate} setDate={setEndDate} />
                </div>
              )}

              {(level === 'critical' || level === 'blocking') && (
                <Field>
                  <FieldLabel>Affected services</FieldLabel>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {AVAILABLE_SERVICES.map((service) => {
                      const SvcIcon = service.icon;
                      const isSelected = services.includes(service.label);
                      return (
                        <label
                          key={service.id}
                          className={cn(
                            'bg-popover flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm',
                            'transition-colors duration-fast ease-out',
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
                <FieldLabel htmlFor="m-status-url">Status URL (optional)</FieldLabel>
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
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={isPending || (!isNone && !message)}
            variant={level === 'blocking' || level === 'critical' ? 'destructive' : 'default'}
            className="gap-1.5"
          >
            {isPending ? <Loading className="size-4 shrink-0" /> : null}
            {isNone ? 'Clear notifications' : 'Activate'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
