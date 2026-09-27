'use client';

import { useId } from 'react';

import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PrincipalPicker } from '@/features/workspace/shared/access/principal-picker';
import { useTranslations } from '@/i18n/use-translations';

import type { NewAccountAudience, NewAccountDraft } from './view/connector-connections';

/**
 * The Add account form: a name, and who can use the account. One form for
 * Customize → Connectors and for the chat connect dialog, so both create the
 * same account the same way. The parent owns the draft and the submit.
 */
export function AddAccountFields({
  projectId,
  value,
  onChange,
  labelTaken,
  canManageConnections,
  accountId,
  everyoneLabel,
  hint,
  disabled = false,
  autoFocus = false,
}: {
  projectId: string;
  value: NewAccountDraft;
  onChange: (next: NewAccountDraft) => void;
  /** The name is one an account of the same owner already uses. */
  labelTaken: boolean;
  canManageConnections: boolean;
  accountId: string | null | undefined;
  /** "Everyone in {project}". */
  everyoneLabel: string;
  /** The line under the name when it is free. */
  hint: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tSharing = useTranslations('accessSharing');
  const id = useId();
  const label = value.label.trim();

  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-label`}>{tI18nComplete.raw('textdcd1d5223f73')}</FieldLabel>
        <Input
          id={`${id}-label`}
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
          placeholder={tI18nComplete.raw('text945ce03ec79f')}
          maxLength={255}
          autoFocus={autoFocus}
          aria-invalid={labelTaken || undefined}
          disabled={disabled}
        />
        {labelTaken ? (
          <FieldDescription className="text-destructive" role="alert">
            {tSharing('nameTaken', { label })}
          </FieldDescription>
        ) : (
          <FieldDescription>{hint}</FieldDescription>
        )}
      </Field>
      <div className="space-y-2">
        <FieldLabel>{tSharing('whoCanUse')}</FieldLabel>
        <RadioGroup
          value={value.audience}
          onValueChange={(next) => onChange({ ...value, audience: next as NewAccountAudience })}
          className="space-y-2"
        >
          <RadioGroupItem
            value="private"
            id={`${id}-private`}
            label={tSharing('onlyYou')}
            description={tSharing('onlyYouDescription')}
            size="lg"
            variant="outline"
            disabled={disabled}
          />
          <RadioGroupItem
            value="project"
            id={`${id}-project`}
            label={everyoneLabel}
            description={tSharing('everyoneMeta')}
            size="lg"
            variant="outline"
            disabled={disabled || !canManageConnections}
          />
          <RadioGroupItem
            value="members"
            id={`${id}-members`}
            label={tSharing('specificPeople')}
            description={tSharing('specificPeopleDescription')}
            size="lg"
            variant="outline"
            disabled={disabled || !canManageConnections || !accountId}
          />
        </RadioGroup>
        {canManageConnections ? null : (
          <p className="text-muted-foreground text-xs">{tSharing('shareRequiresManage')}</p>
        )}
        {value.audience === 'members' ? (
          <PrincipalPicker
            scope={{ kind: 'project', projectId }}
            selection="multi"
            kinds={['member', 'group']}
            value={{ memberIds: value.picked.memberIds, groupIds: value.picked.groupIds, inviteEmails: [] }}
            onChange={(next) =>
              onChange({ ...value, picked: { memberIds: next.memberIds, groupIds: next.groupIds } })
            }
            disabled={disabled}
            autoFocus={false}
            emptyLabel={tI18nComplete.raw('textd2600c68a9ff')}
            allExcludedLabel={tI18nComplete.raw('textf68d7561db3d')}
          />
        ) : null}
      </div>
    </>
  );
}
