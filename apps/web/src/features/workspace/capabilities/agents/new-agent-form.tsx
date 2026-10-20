'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';
import type { AgentConfigBlock } from '@kortix/sdk';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ModalBody, ModalFooter } from '@/components/ui/modal';

export function NewAgentForm({ existingNames, pending, onSubmit, onCancel }: {
  existingNames: string[];
  pending: boolean;
  onSubmit: (name: string, block: AgentConfigBlock) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('agents.manualCreate');
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const slug = name.trim();
  const duplicate = existingNames.includes(slug);
  const valid = /^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug) && !duplicate && Boolean(instructions.trim());
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (valid && !pending) onSubmit(slug, { behavior: { mode: 'primary', prompt: instructions.trim() } });
    }}>
      <ModalBody className="space-y-4">
        <Field>
          <FieldLabel htmlFor="new-agent-name">{t('name')}</FieldLabel>
          <Input id="new-agent-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus disabled={pending} required maxLength={128} pattern="[a-z0-9][a-z0-9_-]{0,127}" aria-invalid={duplicate || undefined} />
          <FieldDescription role={duplicate ? 'alert' : undefined}>
            {duplicate ? t('duplicate') : t('nameHint')}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="new-agent-instructions">{t('instructions')}</FieldLabel>
          <Textarea id="new-agent-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} disabled={pending} required rows={5} />
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="outline-ghost" onClick={onCancel} disabled={pending}>{t('cancel')}</Button>
        <Button type="submit" disabled={!valid || pending}>{pending ? t('creating') : t('submit')}</Button>
      </ModalFooter>
    </form>
  );
}
