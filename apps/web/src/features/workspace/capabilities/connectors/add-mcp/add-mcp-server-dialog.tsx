'use client';

import {
  createConnector,
  deleteConnector,
  getProjectDetail,
  listConnections,
  reconcileConnection,
  reconcileMemberConnection,
  setConnectorCredential,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
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
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { connectorHref } from '@/features/workspace/capabilities/connectors/connector-routes';
import { AudienceFields } from '@/features/workspace/customize/sections/add-account-fields';
import { isAuthChallenge } from '@/features/workspace/customize/sections/connector-connection-form';
import { createConnectorWithOptionalOAuth2 } from '@/features/workspace/customize/sections/connector-oauth2';
import { startDiscoveredSignIn } from '@/features/workspace/customize/sections/connector-oauth2-start';
import {
  connectorConnectionRows,
  newAccountGrantees,
  type NewAccountDraft,
} from '@/features/workspace/customize/sections/view/connector-connections';
import { grantConnectionAccess } from '@/features/workspace/shared/access/access-dialog-share';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { addMcpServer, mcpServerIdentity } from './add-mcp-server';

type Audience = Pick<NewAccountDraft, 'audience' | 'picked'>;

const NO_PICKS: Audience['picked'] = { memberIds: [], groupIds: [], agentIds: [] };

/**
 * New → MCP server (KRTX-2185): paste the server's URL, choose who can use it
 * ("Only you" preselected), Connect. The connector, its account and the
 * server's sign-in run in one step; the browser goes straight to the
 * provider's consent page. It replaced eight steps through the custom
 * connector form, Sign in and Add account.
 */
export function AddMcpServerDialog({
  projectId,
  open,
  onOpenChange,
  takenSlugs,
  onAdded,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Slugs of the project's connectors: a new server never reuses one. */
  takenSlugs: readonly string[];
  /** The connector list changed. */
  onAdded: () => void;
}) {
  const t = useTranslations('connectorPages');
  const tSharing = useTranslations('accessSharing');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const id = useId();
  const accountId = useProjectAccountId(projectId);
  const canManageConnections =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, { accountId })
      .allowed === true;
  const projectQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = projectQuery.data?.project?.name ?? '';
  const everyoneLabel = projectName
    ? tSharing('everyone', { project: projectName })
    : tSharing('visibilityEveryone');

  const [url, setUrl] = useState('');
  const [audience, setAudience] = useState<Audience>({ audience: 'private', picked: NO_PICKS });
  const identity = url.trim() ? mcpServerIdentity(url, takenSlugs) : null;
  const urlInvalid = url.trim() !== '' && identity === null;

  const add = useMutation({
    mutationFn: () =>
      addMcpServer(
        projectId,
        {
          url,
          audience: audience.audience,
          grantees: newAccountGrantees(audience.picked),
          takenSlugs,
          returnUrl: (slug) => `${window.location.origin}${connectorHref(projectId, slug)}`,
        },
        {
          createConnector: (pid, draft) =>
            createConnectorWithOptionalOAuth2(pid, draft, null, {
              createConnector,
              deleteConnector,
              setConnectorCredential,
            }),
          createMemberAccount: reconcileMemberConnection,
          projectAccount: async (pid, slug, label) => {
            // The connector's own shared account, made with it: sign that one
            // in, so it stays the connector's default.
            const { connections } = await listConnections(pid);
            const made = connectorConnectionRows(connections, slug).find(
              (row) => row.owner_type === 'project',
            );
            return (
              made ??
              reconcileConnection(pid, { connector_alias: slug, owner_type: 'project', label })
            );
          },
          grantAccess: (pid, connectionId, grantees) =>
            grantConnectionAccess(accountId ?? '', pid, connectionId, grantees),
          startSignIn: startDiscoveredSignIn,
        },
      ),
    onSuccess: (result) => {
      onAdded();
      if (result.signInUrl) {
        window.location.assign(result.signInUrl);
        return;
      }
      const { name } = result;
      if (result.signInError) {
        errorToast(t('addMcpSignInFailed', { name, reason: result.signInError }));
      } else if (result.syncError) {
        warningToast(t('installedSyncFailed', { name, error: result.syncError }));
      } else {
        successToast(t('addMcpConnected', { name }));
      }
      onOpenChange(false);
      // A server that refused the probe and has no one-click sign-in asks
      // for its credential there.
      const needsCredential = result.syncError !== null && isAuthChallenge(result.syncError);
      router.push(
        connectorHref(
          projectId,
          result.slug,
          needsCredential ? { connect: { connectionId: result.connectionId } } : {},
        ),
      );
    },
    onError: (error: Error) => errorToast(error.message || t('addMcpFailed')),
  });

  const picks =
    audience.picked.memberIds.length +
    audience.picked.groupIds.length +
    (audience.picked.agentIds?.length ?? 0);
  const canSubmit =
    identity !== null &&
    !add.isPending &&
    (audience.audience === 'private' ||
      (canManageConnections && (audience.audience === 'project' || (Boolean(accountId) && picks > 0))));

  const close = (next: boolean) => {
    if (add.isPending) return;
    onOpenChange(next);
    if (!next) {
      setUrl('');
      setAudience({ audience: 'private', picked: NO_PICKS });
    }
  };

  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('addMcpTitle')}</ModalTitle>
          <ModalDescription>{t('addMcpDescription')}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) add.mutate();
          }}
        >
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <Field>
              <FieldLabel htmlFor={`${id}-url`}>{t('addMcpUrlLabel')}</FieldLabel>
              <Input
                id={`${id}-url`}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://mcp.example.com/mcp"
                aria-invalid={urlInvalid || undefined}
                disabled={add.isPending}
                autoFocus
              />
              {urlInvalid ? (
                <FieldDescription className="text-destructive" role="alert">
                  {t('addMcpUrlInvalid')}
                </FieldDescription>
              ) : (
                <FieldDescription>
                  {identity ? t('addMcpUrlNamed', { name: identity.name }) : t('addMcpUrlHint')}
                </FieldDescription>
              )}
            </Field>
            <AudienceFields
              projectId={projectId}
              value={audience}
              onChange={setAudience}
              canShare={canManageConnections}
              accountId={accountId}
              everyoneLabel={everyoneLabel}
              shareRequiresLabel={tSharing('shareRequiresManage')}
              disabled={add.isPending}
            />
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              onClick={() => close(false)}
              disabled={add.isPending}
            >
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {add.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('addMcpConnect')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
