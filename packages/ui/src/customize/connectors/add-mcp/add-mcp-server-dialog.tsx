'use client';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useUiRouter } from '../../../providers/ui-provider';
import { useId, useState } from 'react';

import { Button } from '../../../primitives/button';
import { Field, FieldDescription, FieldLabel } from '../../../primitives/field';
import { Input } from '../../../primitives/input';
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
import { errorToast, successToast, warningToast } from '../../../primitives/toast';
import { connectorHref } from '../connector-routes';
import { AudienceFields } from '../../sections/add-account-fields';
import { isAuthChallenge } from '../../sections/connector-connection-form';
import {
  newAccountGrantees,
  type NewAccountDraft,
} from '../../sections/view/connector-connections';
import { useTranslations } from '../../../i18n';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCan } from '../../../internal/lib/use-project-can';

import type { McpServerApp } from '../install/mcp-first';
import { addMcpServer, mcpAppIdentity, mcpServerIdentity } from './add-mcp-server';
import { sdkAddMcpServerDeps } from './add-mcp-server-deps';

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
  app = null,
  initial = null,
}: {
  projectId: string;
  /** A catalogue app's own MCP server: the URL is filled in and the dialog
   *  is titled for the app. Null for a server the user pastes. */
  app?: McpServerApp | null;
  /** A pasted server prefilled from a link (an agent's `setup_url`): a person confirms it here. */
  initial?: { url: string; name?: string } | null;
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
  const router = useUiRouter();
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

  const [url, setUrl] = useState(app?.url ?? initial?.url ?? '');
  const [audience, setAudience] = useState<Audience>({ audience: 'private', picked: NO_PICKS });
  // The catalogue app's own server, unchanged: named after the app, and its
  // sign-in is known to be one click (`mcpServerFor`).
  const appServer = app !== null && url.trim() === app.url;
  const identity = !url.trim()
    ? null
    : appServer
      ? mcpAppIdentity(app.name, takenSlugs)
      : mcpServerIdentity(url, takenSlugs);
  const urlInvalid = url.trim() !== '' && identity === null;
  // The profile's name: proposed from the app or the URL until the user edits it.
  const [nameEdit, setNameEdit] = useState<string | null>(initial?.name ?? null);
  const name = (nameEdit ?? identity?.name ?? '').trim();

  const add = useMutation({
    mutationFn: () =>
      addMcpServer(
        projectId,
        {
          url,
          ...(name ? { appName: name } : {}),
          ...(appServer ? { signIn: true } : {}),
          audience: audience.audience,
          grantees: newAccountGrantees(audience.picked),
          takenSlugs,
          returnUrl: (slug) => `${window.location.origin}${connectorHref(projectId, slug)}`,
        },
        sdkAddMcpServerDeps(accountId),
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
    /[a-z0-9]/i.test(name) &&
    !add.isPending &&
    (audience.audience === 'private' ||
      (canManageConnections && (audience.audience === 'project' || (Boolean(accountId) && picks > 0))));

  const close = (next: boolean) => {
    if (add.isPending) return;
    onOpenChange(next);
    if (!next) {
      setUrl(app?.url ?? '');
      setNameEdit(null);
      setAudience({ audience: 'private', picked: NO_PICKS });
    }
  };

  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            {app ? t('addMcpAppTitle', { name: app.name }) : t('addMcpTitle')}
          </ModalTitle>
          <ModalDescription>
            {app ? t('addMcpAppDescription', { name: app.name }) : t('addMcpDescription')}
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) add.mutate();
          }}
        >
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            {/* A catalogue app's own server: its URL is known, so the dialog
                asks only who can use it. The URL is not a choice to make. */}
            {app ? null : (
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
                autoFocus={!app}
              />
              {urlInvalid ? (
                <FieldDescription className="text-destructive" role="alert">
                  {t('addMcpUrlInvalid')}
                </FieldDescription>
              ) : (
                <FieldDescription>{t('addMcpUrlHint')}</FieldDescription>
              )}
            </Field>
            )}
            {app && nameEdit === null ? null : (
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{t('installNameLabel')}</FieldLabel>
              <Input
                id={`${id}-name`}
                value={nameEdit ?? identity?.name ?? ''}
                onChange={(event) => setNameEdit(event.target.value)}
                autoComplete="off"
                disabled={add.isPending || identity === null}
              />
              <FieldDescription>{t('installProfileHint')}</FieldDescription>
            </Field>
            )}
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
            {app && nameEdit === null ? (
              <Button
                type="button"
                variant="text"
                size="sm"
                className="px-0"
                onClick={() => setNameEdit(identity?.name ?? app.name)}
                disabled={add.isPending}
              >
                {t('installRename')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline-ghost"
              className={app && nameEdit === null ? 'sm:ml-auto' : undefined}
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
