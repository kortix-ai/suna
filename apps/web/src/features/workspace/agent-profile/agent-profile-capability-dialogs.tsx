'use client';

import {
  activateConnectorAuthorization,
  listConnectorAuthorizations,
  listConnectors,
  pipedreamConnectConnectorAuthorization,
  pipedreamFinalizeConnectorAuthorization,
  reconcileConnectorAuthorization,
  reconcileMemberConnectorAuthorization,
  revokeConnectorAuthorization,
  type AdminConnector,
  type AgentProfile,
  type AgentProfileIntegration,
  type ConnectorAuthorization,
} from '@kortix/sdk';
import { type useAgentProfileMutations } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  LinkBreakIcon,
  LockKeyIcon,
  PlugsConnectedIcon,
} from '@phosphor-icons/react';
import { createFrontendClient } from '@pipedream/sdk/browser';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { withPipedreamOverlayEscape } from '@/hooks/connectors/use-pipedream-connect-member';
import { useCustomizeStore } from '@/stores/customize-store';

import { activeProfileSections } from './agent-profile-utils';

type ProfileMutations = ReturnType<typeof useAgentProfileMutations>;

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: AgentProfile;
  mutations: ProfileMutations;
  onConflict: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function InstructionsDialog({
  open,
  onOpenChange,
  profile,
  mutations,
  onConflict,
}: DialogProps) {
  const instructions = activeProfileSections(profile).instructions ?? {};
  const [prompt, setPrompt] = useState(instructions.prompt ?? '');
  const [description, setDescription] = useState(instructions.description ?? '');
  const revisionRef = useRef(profile.revision);
  const [savedRef] = useState(() => ({ current: JSON.stringify({ prompt, description }) }));
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');

  useEffect(() => {
    revisionRef.current = Math.max(revisionRef.current, profile.revision);
  }, [profile.revision]);

  useEffect(() => {
    if (!open) return;
    const nextSerialized = JSON.stringify({ prompt, description });
    if (nextSerialized === savedRef.current) return;
    setSaveState('saving');
    const timer = window.setTimeout(async () => {
      try {
        const draft = await mutations.updateDraft.mutateAsync({
          expectedRevision: revisionRef.current,
          sections: {
            instructions: {
              ...activeProfileSections(profile).instructions,
              prompt,
              description: description || undefined,
            },
          },
        });
        revisionRef.current = draft.revision;
        savedRef.current = nextSerialized;
        setSaveState('saved');
      } catch (error) {
        setSaveState('error');
        onConflict();
        errorToast(errorMessage(error, 'Instructions could not be saved'));
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [description, mutations.updateDraft, onConflict, open, profile, prompt, savedRef]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent variant="base" className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>Instructions</ModalTitle>
          <ModalDescription>Define how {profile.agent_name} behaves and responds.</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-5 pt-5">
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="agent-profile-description">Role</FieldLabel>
              <Input
                id="agent-profile-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Customer support specialist"
                maxLength={500}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-profile-instructions">Instructions</FieldLabel>
              <Textarea
                id="agent-profile-instructions"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Explain the goals, boundaries, and response style for this agent."
                minHeight={240}
                maxHeight={440}
                autoFocus
              />
            </Field>
          </FieldGroup>
        </ModalBody>
        <ModalFooter className="border-border border-t py-3">
          <span
            className="text-muted-foreground mr-auto inline-flex items-center gap-1.5 text-xs"
            role="status"
          >
            {saveState === 'saving' ? <Loading className="size-3" /> : null}
            {saveState === 'saving'
              ? 'Saving draft'
              : saveState === 'error'
                ? 'Draft not saved'
                : 'Draft saved'}
          </span>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function scopesFrom(profile: ConnectorAuthorization): string[] {
  const scopes = profile.metadata.scopes;
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
}

function canWrite(profile: ConnectorAuthorization, scopes: string[]): boolean {
  if (profile.metadata.can_write === true) return true;
  return scopes.some((scope) =>
    /(^|[.:/_-])(write|send|create|update|delete|manage)([.:/_-]|$)/i.test(scope),
  );
}

function profileToIntegration(profile: ConnectorAuthorization): AgentProfileIntegration {
  const scopes = scopesFrom(profile);
  return {
    profile_id: profile.profile_id,
    slug: profile.connector_alias,
    provider: profile.connector_alias.split(/[-_]/)[0] || profile.connector_alias,
    display_name: profile.label,
    scopes,
    can_write: canWrite(profile, scopes),
    status: 'pending_publication',
    error: null,
  };
}

export function IntegrationsDialog({
  open,
  onOpenChange,
  profile,
  mutations,
  onConflict,
}: DialogProps) {
  const openCustomize = useCustomizeStore((state) => state.openCustomize);
  const [revokeTarget, setRevokeTarget] = useState<AgentProfileIntegration | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [connectorSlug, setConnectorSlug] = useState('');
  const [connecting, setConnecting] = useState(false);
  const profiles = useQuery({
    queryKey: ['connector-profiles', profile.project_id],
    queryFn: () => listConnectorAuthorizations(profile.project_id),
    enabled: open,
    staleTime: 30_000,
  });
  const connectors = useQuery({
    queryKey: ['agent-profile-connectors', profile.project_id],
    queryFn: () => listConnectors(profile.project_id),
    enabled: open,
    staleTime: 30_000,
  });
  const integrations = useMemo(() => activeProfileSections(profile).integrations ?? [], [profile]);
  const activeProfiles = useMemo(
    () => (profiles.data?.profiles ?? []).filter((item) => item.status === 'active'),
    [profiles.data?.profiles],
  );
  const selectedIds = useMemo(
    () => new Set(integrations.map((integration) => integration.profile_id)),
    [integrations],
  );
  const selectedSlugs = useMemo(
    () => new Set(integrations.map((integration) => integration.slug)),
    [integrations],
  );
  const connectable = useMemo(
    () =>
      (connectors.data?.connectors ?? []).filter(
        (connector) =>
          connector.provider === 'pipedream' &&
          connector.status !== 'disabled' &&
          !(profiles.data?.profiles ?? []).some(
            (authorization) =>
              authorization.connector_alias === connector.slug && authorization.status === 'active',
          ),
      ),
    [connectors.data, profiles.data],
  );

  useEffect(() => {
    if (!open) return;
    if (connectorSlug && connectable.some((connector) => connector.slug === connectorSlug)) return;
    setConnectorSlug(connectable[0]?.slug ?? '');
  }, [connectable, connectorSlug, open]);

  const stage = async (next: AgentProfileIntegration[], message: string) => {
    try {
      await mutations.updateDraft.mutateAsync({
        expectedRevision: profile.revision,
        sections: { integrations: next },
      });
      successToast(message);
    } catch (error) {
      onConflict();
      errorToast(errorMessage(error, 'Integration draft could not be updated'));
    }
  };

  const add = (authorization: ConnectorAuthorization) => {
    const addition = profileToIntegration(authorization);
    const withoutProvider = integrations.filter(
      (integration) => integration.slug !== addition.slug,
    );
    void stage([...withoutProvider, addition], `${authorization.label} added to the draft`);
  };

  const connect = async () => {
    const connector = connectable.find((item) => item.slug === connectorSlug);
    if (!connector) return;
    setConnecting(true);
    let authorizationId: string | null = null;
    let finalized = false;
    try {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const label = `${connector.name} for ${profile.agent_name} ${new Date().toISOString().slice(0, 10)}`;
      const metadata = {
        agent_profile_draft_agent: profile.agent_name,
        agent_profile_draft_expires_at: expiresAt,
      };
      const authorization =
        connector.authorizationStrategy === 'user'
          ? await reconcileMemberConnectorAuthorization(profile.project_id, {
              connector_alias: connector.slug,
              label,
              metadata,
            })
          : await reconcileConnectorAuthorization(profile.project_id, {
              connector_alias: connector.slug,
              owner_type: 'project',
              label,
              metadata,
            });
      authorizationId = authorization.profile_id;
      await activateConnectorAuthorization(profile.project_id, authorization.profile_id);
      const { token, app } = await pipedreamConnectConnectorAuthorization(
        profile.project_id,
        authorization.profile_id,
      );
      if (!token || !app) throw new Error('OAuth is not configured for this integration.');
      const client = createFrontendClient({
        externalUserId: `${profile.project_id}:${connector.slug}:${authorization.profile_id}`,
        tokenCallback: async () => ({ token, connect_link_url: undefined, expires_at: '' }) as any,
      });
      const releaseOverlay = withPipedreamOverlayEscape();
      let connected = false;
      try {
        connected = await new Promise<boolean>((resolve, reject) => {
          client.connectAccount({
            app,
            token,
            onSuccess: () => resolve(true),
            onClose: (status: { successful: boolean }) => resolve(status.successful),
            onError: (error: unknown) =>
              reject(
                new Error(
                  error instanceof Error && error.message ? error.message : 'Connection cancelled',
                ),
              ),
          });
        });
      } finally {
        releaseOverlay();
      }
      if (!connected) {
        await revokeConnectorAuthorization(profile.project_id, authorization.profile_id);
        await profiles.refetch();
        return;
      }
      const finalizeResult = await pipedreamFinalizeConnectorAuthorization(
        profile.project_id,
        authorization.profile_id,
      );
      if (!finalizeResult.connected) {
        throw new Error('The connected account could not be finalized.');
      }
      finalized = true;
      const addition = profileToIntegration(authorization);
      await stage(
        [...integrations.filter((integration) => integration.slug !== addition.slug), addition],
        `${connector.name} connected and added to the draft`,
      );
      await profiles.refetch();
    } catch (error) {
      if (authorizationId && !finalized) {
        await revokeConnectorAuthorization(profile.project_id, authorizationId).catch(
          () => undefined,
        );
        void profiles.refetch();
      }
      errorToast(errorMessage(error, 'Integration could not be connected'));
    } finally {
      setConnecting(false);
    }
  };

  const remove = (integration: AgentProfileIntegration) => {
    void stage(
      integrations.filter((entry) => entry.profile_id !== integration.profile_id),
      `${integration.display_name} removed from the draft`,
    );
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const persistedProfileId = /^[0-9a-f-]{36}$/i.test(revokeTarget.profile_id)
        ? revokeTarget.profile_id
        : (profiles.data?.profiles.find(
            (authorization) =>
              authorization.connector_alias === revokeTarget.slug && authorization.is_default,
          )?.profile_id ??
          profiles.data?.profiles.find(
            (authorization) => authorization.connector_alias === revokeTarget.slug,
          )?.profile_id);
      if (persistedProfileId) {
        await revokeConnectorAuthorization(profile.project_id, persistedProfileId);
      }
      await mutations.updateDraft.mutateAsync({
        expectedRevision: profile.revision,
        sections: {
          integrations: integrations.filter(
            (entry) => entry.profile_id !== revokeTarget.profile_id,
          ),
        },
      });
      successToast(`${revokeTarget.display_name} revoked`);
      setRevokeTarget(null);
      void profiles.refetch();
    } catch (error) {
      onConflict();
      errorToast(errorMessage(error, 'Integration could not be revoked'));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent variant="base" className="lg:max-w-2xl">
          <ModalHeader>
            <ModalTitle>Integrations</ModalTitle>
            <ModalDescription>
              Select the connected systems available to {profile.agent_name}.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[70vh] space-y-5 overflow-y-auto pt-5">
            {integrations.length > 0 ? (
              <section className="space-y-2" aria-labelledby="agent-integrations-selected">
                <h3 id="agent-integrations-selected" className="text-sm font-medium">
                  Agent access
                </h3>
                <div className="divide-border divide-y">
                  {integrations.map((integration) => (
                    <div
                      key={`${integration.slug}:${integration.profile_id}`}
                      className="flex min-h-14 items-center gap-3 py-2"
                    >
                      <span className="bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-sm">
                        <PlugsConnectedIcon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{integration.display_name}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          <Badge
                            size="xs"
                            variant={
                              integration.status === 'pending_publication' ? 'warning' : 'success'
                            }
                          >
                            {integration.status === 'pending_publication'
                              ? 'Connected, not available to agent'
                              : 'Available to agent'}
                          </Badge>
                          <span className="text-muted-foreground text-xs">
                            {integration.can_write ? 'Can take actions' : 'Read only'}
                          </span>
                        </div>
                        {integration.scopes.length > 0 ? (
                          <p className="text-muted-foreground mt-1 truncate text-xs">
                            {integration.scopes.join(', ')}
                          </p>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(integration)}
                        disabled={mutations.updateDraft.isPending}
                      >
                        Remove
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Revoke ${integration.display_name}`}
                        onClick={() => setRevokeTarget(integration)}
                      >
                        <LinkBreakIcon className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="space-y-2" aria-labelledby="agent-integrations-connected">
              <div className="flex items-center justify-between gap-3">
                <h3 id="agent-integrations-connected" className="text-sm font-medium">
                  Connected accounts
                </h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    openCustomize('connectors');
                  }}
                >
                  <ArrowSquareOutIcon className="size-3.5" />
                  Manage
                </Button>
              </div>
              {profiles.isLoading ? (
                <div className="flex h-20 items-center justify-center">
                  <Loading className="size-4" />
                </div>
              ) : profiles.isError ? (
                <p className="text-destructive py-4 text-sm" role="alert">
                  {errorMessage(profiles.error, 'Connected accounts could not be loaded')}
                </p>
              ) : activeProfiles.length === 0 ? (
                <div className="border-border flex min-h-24 items-center gap-3 border-y py-4">
                  <LockKeyIcon className="text-muted-foreground size-5" />
                  <p className="text-muted-foreground text-sm">No connected accounts.</p>
                </div>
              ) : (
                <div className="divide-border divide-y">
                  {activeProfiles.map((authorization) => {
                    const selected =
                      selectedIds.has(authorization.profile_id) ||
                      selectedSlugs.has(authorization.connector_alias);
                    return (
                      <div
                        key={authorization.profile_id}
                        className="flex min-h-14 items-center gap-3 py-2"
                      >
                        <span className="bg-muted inline-flex size-9 shrink-0 items-center justify-center rounded-sm">
                          {selected ? (
                            <CheckCircleIcon className="text-kortix-green size-4" />
                          ) : (
                            <PlugsConnectedIcon className="size-4" />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{authorization.label}</p>
                          <p className="text-muted-foreground truncate text-xs">
                            {authorization.connector_alias}
                          </p>
                        </div>
                        <Button
                          variant={selected ? 'outline' : 'secondary'}
                          size="sm"
                          disabled={selected || mutations.updateDraft.isPending}
                          onClick={() => add(authorization)}
                        >
                          {selected ? 'Added' : 'Add'}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="space-y-3" aria-labelledby="agent-integrations-connect">
              <h3 id="agent-integrations-connect" className="text-sm font-medium">
                Connect an account
              </h3>
              {connectors.isLoading ? (
                <div className="flex h-12 items-center justify-center">
                  <Loading className="size-4" />
                </div>
              ) : connectable.length > 0 ? (
                <div className="flex items-center gap-2">
                  <Select value={connectorSlug} onValueChange={setConnectorSlug}>
                    <SelectTrigger aria-label="Integration to connect" className="min-w-0 flex-1">
                      <SelectValue placeholder="Select an integration" />
                    </SelectTrigger>
                    <SelectContent>
                      {connectable.map((connector: AdminConnector) => (
                        <SelectItem key={connector.slug} value={connector.slug}>
                          {connector.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={connect} disabled={!connectorSlug || connecting}>
                    {connecting ? (
                      <Loading className="size-3" />
                    ) : (
                      <PlugsConnectedIcon className="size-3.5" />
                    )}
                    Connect
                  </Button>
                </div>
              ) : (
                <div className="border-border flex min-h-16 items-center justify-between gap-3 border-y py-3">
                  <p className="text-muted-foreground text-sm">No additional OAuth integrations.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onOpenChange(false);
                      openCustomize('connectors');
                    }}
                  >
                    <ArrowSquareOutIcon className="size-3.5" />
                    Add integration
                  </Button>
                </div>
              )}
            </section>
          </ModalBody>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(next) => !next && setRevokeTarget(null)}
        title="Revoke integration"
        description={
          revokeTarget
            ? `${revokeTarget.display_name} loses access immediately. Its profile grant is also removed from this draft.`
            : ''
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        confirmIcon={<LinkBreakIcon className="size-3.5" />}
        isPending={revoking}
        onConfirm={revoke}
      />
    </>
  );
}

export function AdvancedDialog({
  open,
  onOpenChange,
  profile,
  mutations,
  onConflict,
}: DialogProps) {
  const sections = activeProfileSections(profile);
  const [model, setModel] = useState(sections.instructions?.model ?? '');
  const [temperature, setTemperature] = useState(
    () => sections.instructions?.temperature?.toString() ?? '',
  );
  const [steps, setSteps] = useState(() => sections.instructions?.steps?.toString() ?? '');
  const [workspace, setWorkspace] = useState(sections.advanced?.workspace ?? 'runtime');
  const [enabled, setEnabled] = useState(sections.advanced?.enabled !== false);

  const save = async () => {
    const parsedTemperature = temperature === '' ? undefined : Number(temperature);
    const parsedSteps = steps === '' ? undefined : Number(steps);
    if (
      (parsedTemperature !== undefined &&
        (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2)) ||
      (parsedSteps !== undefined &&
        (!Number.isInteger(parsedSteps) || parsedSteps < 1 || parsedSteps > 10_000))
    ) {
      errorToast('Check the temperature and step limit values.');
      return;
    }
    try {
      await mutations.updateDraft.mutateAsync({
        expectedRevision: profile.revision,
        sections: {
          instructions: {
            ...sections.instructions,
            model: model.trim() || undefined,
            temperature: parsedTemperature,
            steps: parsedSteps,
          },
          advanced: {
            ...sections.advanced,
            workspace,
            enabled,
          },
        },
      });
      successToast('Advanced settings saved to the draft');
      onOpenChange(false);
    } catch (error) {
      onConflict();
      errorToast(errorMessage(error, 'Advanced settings could not be saved'));
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent variant="base" className="lg:max-w-xl">
        <ModalHeader>
          <ModalTitle>Advanced</ModalTitle>
          <ModalDescription>Set runtime limits and workspace access.</ModalDescription>
        </ModalHeader>
        <ModalBody className="pt-5">
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="agent-profile-model">Model override</FieldLabel>
              <Input
                id="agent-profile-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Use project default"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="agent-profile-temperature">Temperature</FieldLabel>
                <Input
                  id="agent-profile-temperature"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                  placeholder="Default"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="agent-profile-steps">Step limit</FieldLabel>
                <Input
                  id="agent-profile-steps"
                  type="number"
                  min={1}
                  max={10_000}
                  value={steps}
                  onChange={(event) => setSteps(event.target.value)}
                  placeholder="Default"
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="agent-profile-workspace">Workspace access</FieldLabel>
              <Select
                value={workspace}
                onValueChange={(value) => setWorkspace(value as typeof workspace)}
              >
                <SelectTrigger id="agent-profile-workspace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="runtime">Runtime workspace</SelectItem>
                  <SelectItem value="read">Read only</SelectItem>
                  <SelectItem value="branch">Isolated branch</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field orientation="horizontal" variant="outline">
              <div className="flex-1">
                <FieldTitle>Agent enabled</FieldTitle>
                <FieldDescription>Disabled agents cannot start new sessions.</FieldDescription>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Agent enabled" />
            </Field>
          </FieldGroup>
        </ModalBody>
        <ModalFooter className="border-border border-t py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={mutations.updateDraft.isPending}>
            {mutations.updateDraft.isPending ? <Loading className="size-3" /> : null}
            Save to draft
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
