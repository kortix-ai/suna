'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import {
  useConnectSlack,
  useDisconnectSlack,
  useSlackInstall,
  useSlackManifest,
  useSlackMode,
  type SlackInstallation,
} from '@/hooks/channels/use-channels-installations';
import { cn } from '@/lib/utils';
import { Check, CheckCircleSolid, ExternalLinkSolid } from '@mynaui/icons-react';
import { Copy, MessageSquare, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';

export function ChannelsView({ projectId }: { projectId: string | null }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { data: install, isLoading: loadingInstall } = useSlackInstall(projectId);
  const { data: mode, isLoading: loadingMode } = useSlackMode(projectId);
  const loading = loadingInstall || loadingMode;
  const oauthInstallUrl = mode?.oauth_available ? mode.install_url : null;

  return (
    <CustomizeSectionWrapper
      title="Channels"
      description={tI18nHardcoded.raw(
        'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextRunThisb83f74db',
      )}
      action={
        projectId && !loading && !install && oauthInstallUrl ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={oauthInstallUrl} target="_blank" rel="noopener noreferrer">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAddTo1729c1b6',
              )}
            </Link>
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        {!projectId ? (
          <InfoBanner tone="neutral">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOpenA4ae69220',
            )}
          </InfoBanner>
        ) : loading ? (
          <div className="space-y-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : !oauthInstallUrl && !install ? (
          <div className="space-y-4">
            <EmptyState
              icon={MessageSquare}
              size="sm"
              title={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrTitleBringbd0857f4',
              )}
              description={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrDescriptionSelf7c5e4adb',
              )}
            />
            <BringYourOwnPanel projectId={projectId} inline />
          </div>
        ) : (
          <>
            {install ? (
              <InfoBanner
                tone="success"
                icon={Check}
                title={`Connected to ${install.workspaceName ?? install.workspaceId}`}
              >
                Bot <code className="font-mono text-xs">{install.botUserId ?? '—'}</code>
                {' · '}Team <code className="font-mono text-xs">{install.workspaceId}</code>
              </InfoBanner>
            ) : null}

            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Workspace</TableHead>
                  <TableHead className="w-[120px]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SlackChannelRow
                  projectId={projectId}
                  installation={install ?? null}
                  oauthInstallUrl={oauthInstallUrl}
                />
              </TableBody>
            </Table>

            {install ? (
              <InfoBanner tone="neutral" icon={CheckCircleSolid}>
                <p className="text-sm">
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextInviteThe94db1964',
                  )}{' '}
                  <span className="text-foreground font-medium">
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextMention67ed74a7',
                    )}
                  </span>{' '}
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextItA7139ed4f',
                  )}{' '}
                  <span className="text-foreground font-medium">Slack CLI</span>.
                </p>
              </InfoBanner>
            ) : oauthInstallUrl ? (
              <BringYourOwnPanel projectId={projectId} />
            ) : null}
          </>
        )}
      </div>
    </CustomizeSectionWrapper>
  );
}

function SlackChannelRow({
  projectId,
  installation,
  oauthInstallUrl,
}: {
  projectId: string;
  installation: SlackInstallation | null;
  oauthInstallUrl: string | null;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const disconnect = useDisconnectSlack();
  const [confirming, setConfirming] = useState(false);

  const connected = Boolean(installation);

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell>
        <div className="flex items-center gap-2.5">
          <Icon.Slack className="size-5 shrink-0" />
          <span className="text-sm font-medium">Slack</span>
        </div>
      </TableCell>
      <TableCell>
        {connected ? (
          <Badge variant="success" size="sm">
            Connected
          </Badge>
        ) : (
          <Badge variant="outline" size="sm" className="text-muted-foreground">
            Not connected
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {connected ? (installation?.workspaceName ?? installation?.workspaceId ?? '—') : '—'}
      </TableCell>
      <TableCell>
        {connected ? (
          confirming ? (
            <div className="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={disconnect.isPending}
                onClick={() =>
                  disconnect.mutate(projectId, {
                    onSuccess: () => setConfirming(false),
                  })
                }
              >
                {disconnect.isPending ? (
                  <Loading className="size-3.5 shrink-0 animate-spin" />
                ) : null}
                Disconnect
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => setConfirming(true)}
            >
              <X className="size-3.5 shrink-0" />
              Disconnect
            </Button>
          )
        ) : oauthInstallUrl ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={oauthInstallUrl} target="_blank" rel="noopener noreferrer">
              Install
            </Link>
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function ConnectedDetails() {
  const tI18nHardcoded = useTranslations('hardcodedUi');

  return (
    <InfoBanner tone="neutral" icon={CheckCircleSolid}>
      <p className="text-sm">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextInviteThe94db1964',
        )}{' '}
        <code className="font-mono text-xs">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextMention67ed74a7',
          )}
        </code>{' '}
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextItA7139ed4f',
        )}{' '}
        <code className="font-mono text-xs">slack</code> CLI.
      </p>
    </InfoBanner>
  );
}

function BringYourOwnPanel({ projectId, inline = false }: { projectId: string; inline?: boolean }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [copied, setCopied] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectSlack();
  const manifest = useSlackManifest(projectId);

  const manifestText = manifest.data ?? '';

  const copyManifest = async () => {
    if (!manifestText) return;
    await navigator.clipboard.writeText(manifestText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const submit = () => {
    setError(null);
    connect.mutate(
      {
        projectId,
        bot_token: botToken.trim(),
        signing_secret: signingSecret.trim(),
      },
      { onError: (e) => setError((e as Error).message) },
    );
  };

  const content =
    step === 1 ? (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextStep12c389f4e',
          )}
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAppManifest040b924e',
              )}
            </span>
            <ButtonGroup>
              <Hint label={copied ? 'Copied' : 'Copy'} side="bottom">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={copyManifest}
                  disabled={!manifestText}
                >
                  {copied ? (
                    <CheckCircleSolid className="size-3.5 shrink-0" />
                  ) : (
                    <Copy className="size-3.5 shrink-0" />
                  )}
                </Button>
              </Hint>
              <Button variant="outline" size="sm" className="gap-1.5" asChild>
                <Link
                  href="https://api.slack.com/apps?new_app=1"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOpenSlacka088997c',
                  )}
                  <ExternalLinkSolid className="size-3.5 shrink-0" />
                </Link>
              </Button>
            </ButtonGroup>
          </div>
          <pre className="border-border bg-muted max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed">
            {manifest.isLoading
              ? 'Loading manifest...'
              : manifest.error
                ? `Failed to load manifest: ${(manifest.error as Error).message}`
                : manifestText}
          </pre>
        </div>

        <ol className="text-muted-foreground list-decimal space-y-1.5 pl-5 text-sm">
          {[
            'Click Open Slack, choose "From a manifest", paste the JSON, confirm.',
            'On the next screen, click Install to Workspace and approve.',
            'Copy the Bot User OAuth Token (xoxb-…) and Signing Secret.',
          ].map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>

        <div className="flex justify-end">
          <Button size="sm" variant="secondary" onClick={() => setStep(2)}>
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextNextPasted1384aaa',
            )}
          </Button>
        </div>
      </div>
    ) : (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextStep22f8cae80',
          )}{' '}
          <code className="font-mono text-xs">project_secrets</code>{' '}
          {tI18nHardcoded.raw(
            'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAlongsideAny8e77bd03',
          )}
        </p>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="bot-token">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextBotUser193e4bfd',
              )}
            </Label>
            <Input
              id="bot-token"
              placeholder={tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxAttrPlaceholderXoxb84fe69f4',
              )}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSlackYouraeeca6ed',
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signing-secret">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSigningSecret2762795e',
              )}
            </Label>
            <Input
              id="signing-secret"
              placeholder="••••••••"
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextSlackYour09fe8ce8',
              )}
            </p>
          </div>
        </div>

        {error ? (
          <InfoBanner tone="destructive" title="Could not connect">
            {error}
          </InfoBanner>
        ) : null}

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
            Back
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={submit}
            disabled={connect.isPending || !botToken.trim() || !signingSecret.trim()}
          >
            {connect.isPending ? <Loading className="mr-2 size-3.5 shrink-0 animate-spin" /> : null}
            {tI18nHardcoded.raw(
              'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextConnectSlack5ad82c3b',
            )}
          </Button>
        </div>
      </div>
    );

  if (inline) return content;

  return (
    <Disclosure variant="outline" className="overflow-hidden" open={open} onOpenChange={setOpen}>
      <DisclosureTrigger variant="outline">
        <Button
          variant="accent"
          className={cn('flex h-fit w-full items-center justify-between rounded-none py-2.5')}
        >
          <div className="min-w-0 text-left">
            <p className="text-sm font-medium">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextBringYourc7326733',
              )}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextForSelf3fbeca22',
              )}
            </p>
          </div>
        </Button>
      </DisclosureTrigger>
      <DisclosureContent
        variant="outline"
        contentClassName="border-border bg-popover border-t px-4 py-5"
      >
        {content}
      </DisclosureContent>
    </Disclosure>
  );
}
