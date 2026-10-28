'use client';

import { useTranslations } from '../../i18n';
import { UiLink, useUiParams } from '../../providers/ui-provider';

import { Button } from '../../primitives/button';
import { projectSettingsSectionHref } from '../project-settings/project-settings-sections';
import { ChannelsSwitchDialog } from './channels-switch-dialog';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { getProject, updateFeatureFlag, type FeatureFlagKey, type ProjectDetail } from '@kortix/sdk';
import { contract, invalidateProject, qk } from '@kortix/sdk/react';
import { FlagIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

/** A disabled surface keeps its enable action and settings link in place. */
export function FeatureGateScreen({
  featureKey,
  featureName,
  description,
  internalOnly = false,
}: {
  featureKey: FeatureFlagKey;
  /** The feature's name, exactly as the Feature flags section lists it. */
  featureName: string;
  /** One sentence: what turning it on would give this project. */
  description: string;
  /** The flag is not offered in Settings (`catalogHidden`): no button, ask Kortix instead. */
  internalOnly?: boolean;
}) {
  const t = useTranslations('featureGate');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const params = useUiParams();
  const projectId = typeof params.id === 'string' ? params.id : undefined;

  const queryClient = useQueryClient();
  const permission = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
  const [error, setError] = useState('');
  const enable = useMutation({
    mutationFn: async (alsoDrive: boolean = false) => {
      if (!projectId || internalOnly || permission.isLoading || permission.allowed !== true) {
        throw new Error('Feature activation is not permitted');
      }
      const updated = await updateFeatureFlag(projectId, featureKey, true);
      return alsoDrive ? updateFeatureFlag(projectId, 'drives', true) : updated;
    },
    onSuccess: (updated) => {
      if (!projectId) return;
      queryClient.setQueryData(qk.project.summary(projectId), updated);
      queryClient.setQueryData<ProjectDetail>(qk.project.detail(projectId), (current) =>
        current ? { ...current, project: updated } : current,
      );
      void invalidateProject(queryClient, projectId);
      void queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
    },
    onError: (cause: Error) => setError(cause.message),
  });
  const channels = featureKey === 'project_channels';
  const [confirming, setConfirming] = useState(false);
  const project = useQuery({
    queryKey: qk.project.summary(projectId ?? ''),
    queryFn: () => getProject(projectId as string),
    enabled: channels && !!projectId,
    ...contract('config'),
  });
  const drive = project.data?.experimental_features?.find((f) => f.key === 'drives' && f.available);

  return (
    <div className="bg-popover rounded-md border px-4 py-5">
      {channels ? (
        <ChannelsSwitchDialog
          open={confirming}
          onOpenChange={setConfirming}
          turningOn
          projectName={project.data?.name ?? ''}
          driveOff={!!drive && !drive.enabled && drive.operator_only !== true}
          onConfirm={(alsoDrive) => {
            setConfirming(false);
            enable.mutate(alsoDrive);
          }}
        />
      ) : null}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="bg-muted/50 flex size-9 shrink-0 items-center justify-center rounded-sm">
            <FlagIcon className="text-muted-foreground size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="text-foreground text-sm font-medium">
              {featureName} {tI18nComplete.raw('text26965989cce5')}
            </p>
            <p className="text-muted-foreground max-w-xl text-xs text-pretty">{description}</p>
            {internalOnly ? (
              <p className="text-muted-foreground max-w-xl text-xs text-pretty">
                {tI18nComplete.raw('text1c41abcc2fff')}
              </p>
            ) : null}
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
        {projectId && !internalOnly ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              disabled={permission.isLoading || permission.allowed !== true || enable.isPending}
              onClick={() => {
                setError('');
                // Channels changes the sidebar for everyone: it asks first.
                if (channels) setConfirming(true);
                else enable.mutate(false);
              }}
            >
              {enable.isPending ? t('enabling') : t('enable', { name: featureName })}
            </Button>
            <Button asChild size="sm" variant="secondary" className="shrink-0">
              <UiLink href={projectSettingsSectionHref(projectId, 'feature-flags')}>
                {tI18nComplete.raw('text20a2e59ba129')}
              </UiLink>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
