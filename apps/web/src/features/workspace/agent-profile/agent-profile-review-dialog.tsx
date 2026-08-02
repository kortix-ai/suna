'use client';

import type { AgentProfile, AgentProfileImpactSummary, AgentProfilePreview } from '@kortix/sdk';
import { type useAgentProfileMutations } from '@kortix/sdk/react';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CurrencyDollarIcon,
  DatabaseIcon,
  FlaskIcon,
  LightningIcon,
  ShieldCheckIcon,
  TimerIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { errorToast, successToast } from '@/components/ui/toast';

import { activeProfileSections } from './agent-profile-utils';

type ProfileMutations = ReturnType<typeof useAgentProfileMutations>;

interface ProfileActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AgentProfile;
  mutations: ProfileMutations;
  onConflict: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const IMPACT_GROUPS: Array<{
  key: keyof AgentProfileImpactSummary;
  label: string;
  icon: typeof DatabaseIcon;
}> = [
  { key: 'data_access', label: 'Data access', icon: DatabaseIcon },
  { key: 'actions', label: 'Actions', icon: LightningIcon },
  { key: 'schedule_changes', label: 'Schedules', icon: TimerIcon },
  { key: 'cost_sensitive_settings', label: 'Cost settings', icon: CurrencyDollarIcon },
];

function ImpactSummary({ preview }: { preview: AgentProfilePreview }) {
  return (
    <section className="space-y-2" aria-labelledby="impact-summary-heading">
      <h3 id="impact-summary-heading" className="text-sm font-medium">
        Impact summary
      </h3>
      <div className="border-border divide-border divide-y border-y">
        {IMPACT_GROUPS.map((group) => {
          const Icon = group.icon;
          const values = preview.impact[group.key];
          return (
            <div key={group.key} className="flex min-h-12 items-start gap-3 py-2.5">
              <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">{group.label}</p>
                <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                  {values.length > 0 ? values.join(', ') : 'No changes'}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function AgentProfileReviewDialog({
  open,
  onOpenChange,
  profile,
  mutations,
  onConflict,
}: ProfileActionDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const draftRevision = profile.draft?.revision;
  const { mutateAsync: loadPreview, reset: resetPreview } = mutations.preview;

  useEffect(() => {
    if (draftRevision === undefined) return;
    resetPreview();
    void loadPreview().catch((error) => {
      onConflict();
      errorToast(errorMessage(error, 'Draft preview could not be loaded'));
    });
  }, [draftRevision, loadPreview, onConflict, resetPreview]);

  const preview = mutations.preview.data;
  const highRisk = preview?.draft.highest_risk === 'high';

  const publish = async () => {
    if (!profile.draft) return;
    try {
      const result = await mutations.publish.mutateAsync({
        expectedRevision: profile.draft.revision,
        acknowledgeHighRisk: highRisk ? acknowledged : undefined,
      });
      const number = result.change_request.number;
      successToast(
        number
          ? `Review ${number} ${result.updated_existing_request ? 'updated' : 'opened'}`
          : 'Profile sent for review',
      );
      onOpenChange(false);
    } catch (error) {
      onConflict();
      errorToast(errorMessage(error, 'Profile could not be sent for review'));
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent variant="base" className="lg:max-w-3xl">
        <ModalHeader>
          <ModalTitle>Review &amp; publish</ModalTitle>
          <ModalDescription>
            Review the effect before one reviewer approves the change.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[72vh] space-y-6 overflow-y-auto pt-5">
          {mutations.preview.isPending ? (
            <div className="flex min-h-48 items-center justify-center">
              <Loading className="size-5" />
            </div>
          ) : preview ? (
            <>
              <ImpactSummary preview={preview} />

              <section className="space-y-2" aria-labelledby="profile-changes-heading">
                <h3 id="profile-changes-heading" className="text-sm font-medium">
                  Changes
                </h3>
                <div className="border-border divide-border divide-y border-y">
                  {preview.changes.map((change) => (
                    <div
                      key={`${change.section}:${change.kind}:${change.resource_id ?? change.summary}`}
                      className="flex min-h-11 items-center gap-3 py-2"
                    >
                      <Badge
                        size="xs"
                        variant={
                          change.risk === 'high'
                            ? 'destructive'
                            : change.risk === 'medium'
                              ? 'warning'
                              : 'muted'
                        }
                      >
                        {change.risk}
                      </Badge>
                      <p className="min-w-0 flex-1 text-sm text-pretty">{change.summary}</p>
                    </div>
                  ))}
                </div>
              </section>

              {highRisk ? (
                <InfoBanner tone="warning" icon={WarningIcon} title="High-risk changes">
                  <div className="space-y-3">
                    <p>
                      This draft can expand permissions, take actions, use secrets, or run on a
                      schedule.
                    </p>
                    <Checkbox
                      checked={acknowledged}
                      onCheckedChange={(checked) => setAcknowledged(checked === true)}
                      label="I reviewed the data access, actions, schedules, and cost settings."
                    />
                  </div>
                </InfoBanner>
              ) : (
                <InfoBanner tone="success" icon={ShieldCheckIcon}>
                  This draft contains {preview.draft.highest_risk}-risk changes.
                </InfoBanner>
              )}

              <Accordion type="single" collapsible>
                <AccordionItem value="technical-details">
                  <AccordionTrigger>Technical details</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    {preview.technical_diff.map((entry) => (
                      <section key={entry.path} className="space-y-2">
                        <p className="text-muted-foreground font-mono text-xs">{entry.path}</p>
                        <div className="grid gap-2 md:grid-cols-2">
                          <pre className="bg-muted max-h-48 overflow-auto rounded-sm p-3 text-xs whitespace-pre-wrap">
                            {entry.before ?? 'New file'}
                          </pre>
                          <pre className="bg-muted max-h-48 overflow-auto rounded-sm p-3 text-xs whitespace-pre-wrap">
                            {entry.after ?? 'Removed'}
                          </pre>
                        </div>
                      </section>
                    ))}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </>
          ) : mutations.preview.isError ? (
            <InfoBanner tone="destructive" icon={WarningIcon}>
              {errorMessage(mutations.preview.error, 'Draft preview could not be loaded')}
            </InfoBanner>
          ) : null}
        </ModalBody>
        <ModalFooter className="border-border border-t py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!preview || mutations.publish.isPending || (highRisk && !acknowledged)}
            onClick={publish}
          >
            {mutations.publish.isPending ? <Loading className="size-3" /> : null}
            Send for review
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function AgentProfileTestDialog({
  open,
  onOpenChange,
  profile,
  mutations,
  onConflict,
}: ProfileActionDialogProps) {
  const router = useRouter();
  const integrations = activeProfileSections(profile).integrations ?? [];
  const pendingWrites = integrations.filter(
    (integration) => integration.can_write && integration.status === 'pending_publication',
  );
  const [includeWrites, setIncludeWrites] = useState(false);

  const testDraft = async () => {
    if (!profile.draft) return;
    try {
      const result = await mutations.testDraft.mutateAsync({
        expectedRevision: profile.draft.revision,
        includePendingWriteIntegrations: includeWrites,
      });
      successToast('Draft test session created');
      onOpenChange(false);
      router.push(`/projects/${profile.project_id}/sessions/${result.session_id}`);
    } catch (error) {
      onConflict();
      errorToast(errorMessage(error, 'Draft test session could not be created'));
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent variant="base" className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Test draft</ModalTitle>
          <ModalDescription>Start an isolated session with draft capabilities.</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4 pt-5">
          <InfoBanner tone="info" icon={FlaskIcon}>
            The test session expires after 24 hours. Draft knowledge is available only in this
            session.
          </InfoBanner>
          {pendingWrites.length > 0 ? (
            <Checkbox
              checked={includeWrites}
              onCheckedChange={(checked) => setIncludeWrites(checked === true)}
              label={`Enable ${pendingWrites.length} pending write integration${pendingWrites.length === 1 ? '' : 's'} for this test`}
            />
          ) : (
            <div className="border-border flex min-h-11 items-center gap-3 border-y py-2 text-sm">
              <CheckCircleIcon className="text-kortix-green size-4" />
              No pending write integrations are enabled.
            </div>
          )}
        </ModalBody>
        <ModalFooter className="border-border border-t py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={mutations.testDraft.isPending} onClick={testDraft}>
            {mutations.testDraft.isPending ? <Loading className="size-3" /> : null}
            Start test session
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
