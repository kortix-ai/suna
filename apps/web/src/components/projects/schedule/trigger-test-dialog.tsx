'use client';

/**
 * "Test with payload": a JSON payload, a Preview that dry-runs it (the
 * rendered prompt, whether the filter lets it through, the session key), and
 * a real run with that payload. A dry run writes nothing.
 */

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
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
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectTrigger } from '@kortix/sdk';
import { useProjectTriggers } from '@kortix/sdk/react';
import { useState } from 'react';

import { InlineError } from './composer-parts';
import { PropertyList } from './schedule-fields';
import { parsePayload } from './trigger-runs-logic';
import { fireResultToast } from './trigger-toast';

export function TriggerTestDialog({
  projectId,
  trigger,
  open,
  onOpenChange,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const { fire, dryRun } = useProjectTriggers(projectId);
  const [text, setText] = useState(trigger.type === 'webhook' ? '{\n  "body": {}\n}' : '{}');
  const parsed = parsePayload(text);
  const invalid = parsed.ok
    ? null
    : parsed.error === 'json'
      ? t.raw('text920ed46028e8')
      : t.raw('text6ea4fcc31727');
  const preview = dryRun.data;
  const failure = (fire.error ?? dryRun.error)?.message;
  const busy = fire.isPending || dryRun.isPending;

  const runPreview = () => {
    if (!parsed.ok) return;
    fire.reset();
    dryRun.mutate({ slug: trigger.slug, payload: parsed.value });
  };
  const runFire = () => {
    if (!parsed.ok) return;
    dryRun.reset();
    fire.mutate(
      { slug: trigger.slug, payload: parsed.value },
      {
        onSuccess: (res) => {
          fireResultToast(res, trigger, projectId, t);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t.raw('textb098a09c78aa')}</ModalTitle>
          <ModalDescription>{t.raw('textff2c3559cd6b')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[60vh] space-y-5 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor="trigger-test-payload">{t.raw('text99733344956d')}</FieldLabel>
            <Textarea
              id="trigger-test-payload"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                dryRun.reset();
              }}
              minHeight={120}
              maxHeight={320}
              spellCheck={false}
              className="font-mono text-xs"
              aria-invalid={invalid ? true : undefined}
            />
            <InlineError message={invalid ?? failure} />
          </Field>

          {preview ? (
            <section className="space-y-3">
              <Label>{t.raw('text5c39123805ff')}</Label>
              <pre className="bg-background max-h-48 overflow-auto rounded-md border px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                {preview.rendered_prompt}
              </pre>
              <PropertyList
                rows={[
                  {
                    label: t.raw('text2631c2f64174'),
                    value: preview.filter_matches
                      ? t.raw('text85a39ab345d6')
                      : t.raw('text1ea442a134b2'),
                  },
                  ...(preview.session_key
                    ? [
                        {
                          label: t.raw('text2319ec274750'),
                          value: <code className="font-mono text-xs">{preview.session_key}</code>,
                        },
                      ]
                    : []),
                ]}
              />
            </section>
          ) : null}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline"
            disabled={!parsed.ok || busy}
            onClick={runPreview}
            className="gap-1.5"
          >
            {dryRun.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t.raw('text4309aba52556')}
          </Button>
          <Button disabled={!parsed.ok || busy} onClick={runFire} className="gap-1.5">
            {fire.isPending ? <Loading className="size-4 shrink-0" /> : null}
            {t.raw('text98ee1ca163c3')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
