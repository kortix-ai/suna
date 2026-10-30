'use client';

/**
 * "Test with payload": a JSON payload, a Preview that dry-runs it (the
 * rendered prompt, whether the filter lets it through, the session key), and
 * a real run with that payload. A dry run writes nothing.
 */

import { Button } from '../../../primitives/button';
import { FieldLabel } from '../../../primitives/field';
import Loading from '../../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import { Textarea } from '../../../primitives/textarea';
import { SolidCheckIcon } from '../../../internal/icons/solid-check-icon';
import { useTranslations } from '../../../i18n';
import { useUiRouter } from '../../../providers/ui-provider';
import type { ProjectTrigger } from '@kortix/sdk';
import { useProjectTriggers } from '@kortix/sdk/react';
import { FlaskIcon, PlayIcon, XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { InlineError } from './composer-parts';
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
  const router = useUiRouter();
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
          fireResultToast(res, trigger, projectId, t, router);
          onOpenChange(false);
        },
      },
    );
  };

  // Split editor and preview: the payload is the inset surface on the
  // left, the preview the paper surface on the right; they stack below `lg`.
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-4xl">
        <ModalHeader>
          <ModalTitle className="flex items-center gap-2 text-sm font-semibold">
            <FlaskIcon className="size-4 shrink-0" />
            {t.raw('textb098a09c78aa')}
          </ModalTitle>
          <ModalDescription className="sr-only">{t.raw('textff2c3559cd6b')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto lg:flex-row">
          <section className="flex min-w-0 flex-1 flex-col gap-2">
            <FieldLabel
              htmlFor="trigger-test-payload"
              className="text-foreground text-xs font-medium"
            >
              {t.raw('text99733344956d')}
            </FieldLabel>
            <Textarea
              id="trigger-test-payload"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                dryRun.reset();
              }}
              minHeight={240}
              maxHeight={480}
              spellCheck={false}
              className="bg-card px-3 py-2.5 font-mono text-xs font-normal tracking-tight"
              aria-invalid={invalid ? true : undefined}
            />
            <InlineError message={invalid ?? failure} />
          </section>

          <div aria-hidden className="bg-border hidden w-px shrink-0 self-stretch lg:block" />

          <section className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground text-xs font-medium">
                {t.raw('text324b134f57c7')}
              </span>
              <Button variant="ghost" size="xs" disabled={!parsed.ok || busy} onClick={runPreview}>
                {dryRun.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                {t.raw('text4309aba52556')}
              </Button>
            </div>
            {preview ? (
              <>
                <dl className="space-y-1">
                  <div className="flex min-h-6 items-center gap-2">
                    <dt className="text-muted-foreground w-24 shrink-0 text-xs">
                      {t.raw('text2631c2f64174')}
                    </dt>
                    <dd className="text-foreground flex items-center gap-1 text-xs font-medium">
                      {preview.filter_matches ? (
                        <SolidCheckIcon className="text-kortix-green size-3.5" />
                      ) : (
                        <XIcon className="text-muted-foreground size-3.5 shrink-0" />
                      )}
                      {preview.filter_matches
                        ? t.raw('text85a39ab345d6')
                        : t.raw('text1ea442a134b2')}
                    </dd>
                  </div>
                  {preview.session_key ? (
                    <div className="flex min-h-6 items-center gap-2">
                      <dt className="text-muted-foreground w-24 shrink-0 text-xs">
                        {t.raw('text2319ec274750')}
                      </dt>
                      <dd className="text-foreground min-w-0 font-mono text-xs tracking-tight break-all">
                        {preview.session_key}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <div className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-xs">{t.raw('text5c39123805ff')}</span>
                  <pre className="bg-background text-foreground max-h-80 overflow-auto rounded-md border px-3 py-2.5 font-mono text-xs tracking-tight break-words whitespace-pre-wrap">
                    {preview.rendered_prompt}
                  </pre>
                </div>
              </>
            ) : null}
          </section>
        </ModalBody>
        <ModalFooter className="items-center sm:justify-between">
          <span className="text-muted-foreground text-xs">{t.raw('text15e8856d4d77')}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t.raw('text19766ed6ccb2')}
            </Button>
            <Button size="sm" disabled={!parsed.ok || busy} onClick={runFire}>
              {fire.isPending ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <PlayIcon className="size-3.5 shrink-0" />
              )}
              {t.raw('text98ee1ca163c3')}
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
