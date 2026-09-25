'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { ErrorState } from '@/features/layout/section/error-state';
import { AccountSecretResourcesPanel } from '@/features/workspace/customize/sections/view/account-secret-resources-panel';

/**
 * Bring your own ChatGPT subscription from where a member picks a model.
 * Customize is manager territory; this dialog is every member's place to
 * connect, reconnect, and remove their ChatGPT accounts in one project. It is
 * the same panel Models → Providers shows, so the two can never disagree.
 */
export function ChatGptAccountsDialog({ projectId, open, onOpenChange }: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('pooledSecrets');
  const common = useTranslations('common');
  const project = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: open,
    ...contract('config'),
  });
  const accountId = project.data?.project?.account_id;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('chatGptSubscription')}</ModalTitle>
          <ModalDescription>{t('oauthPrivateDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          {accountId ? (
            <AccountSecretResourcesPanel accountId={accountId} projectId={projectId} providerId="codex"
              providerName="ChatGPT Plus/Pro" envVar="CODEX_AUTH_JSON" canWrite
              oauth={{ projectId, onConnected: () => undefined }} />
          ) : project.isError ? (
            <ErrorState size="sm" title={t('loadError')}
              action={<Button size="sm" variant="secondary" disabled={project.isFetching} onClick={() => void project.refetch()}>{common('retry')}</Button>} />
          ) : (
            <div role="status" aria-label={t('loadingKeys')}><Loading /></div>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
