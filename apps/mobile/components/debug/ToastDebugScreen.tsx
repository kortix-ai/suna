/**
 * ToastDebugScreen — every toast the app shows, one row each; a tap fires it.
 *
 * Mirrors the web page `/debug/toast`: the status toasts, actions, undo, the
 * schedule toasts (clock + status badge + rim reflection), and loading →
 * success / error. `sonner-native` draws the card, so there is no inline
 * preview: fire a row and read the toast at the top of the screen. Open it
 * from the project home's "Debug toasts" button in a dev build, or with
 * `kortix://toast-debug`.
 */

import { SettingsGroup, SettingsHeader, SettingsPage, SettingsRow } from '@/components/kortix/settings-list';
import { useToast, type ToastOptions } from '@/components/kortix/toast-provider';
import {
  ArchiveIcon,
  CheckCircleIcon,
  ClockIcon,
  InfoIcon,
  LightningIcon,
  TrashIcon,
  WarningCircleIcon,
  WebhooksLogoIcon,
  XCircleIcon,
  type AppIcon,
} from '@/lib/icons';
import { View } from 'react-native';

type Toast = ReturnType<typeof useToast>;

interface Case {
  label: string;
  icon: AppIcon;
  fire: (toast: Toast) => void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => undefined;

const SCHEDULE: ToastOptions['entity'] = { icon: ClockIcon, label: 'Weekly revenue digest' };

const GROUPS: { title: string; cases: Case[] }[] = [
  {
    title: 'Status',
    cases: [
      { label: 'Success', icon: CheckCircleIcon, fire: (t) => t.success('Project created') },
      {
        label: 'Success + description',
        icon: CheckCircleIcon,
        fire: (t) => t.success('Changes saved', { description: 'Your settings apply to every new session.' }),
      },
      {
        label: 'Error + description',
        icon: XCircleIcon,
        fire: (t) =>
          t.error('Could not save changes', {
            description: 'The API returned 409. Someone else edited this project.',
          }),
      },
      {
        label: 'Warning + description',
        icon: WarningCircleIcon,
        fire: (t) => t.warning('Credits are running low', { description: '$4.20 left. Sessions pause at $0.' }),
      },
      { label: 'Info', icon: InfoIcon, fire: (t) => t.info('Message copied') },
    ],
  },
  {
    title: 'Actions',
    cases: [
      {
        label: 'Link action',
        icon: CheckCircleIcon,
        fire: (t) =>
          t.success('Trigger created', {
            entity: { icon: ClockIcon, label: 'Weekly revenue digest · Mon 9:00' },
            action: { label: 'View trigger', onPress: noop },
          }),
      },
      {
        label: 'Error + action',
        icon: XCircleIcon,
        fire: (t) =>
          t.error('Upload failed', {
            description: 'report-q3.pdf is larger than 50 MB.',
            action: { label: 'Try again', onPress: noop },
          }),
      },
      {
        label: 'Undo · session archived',
        icon: ArchiveIcon,
        fire: (t) =>
          t.success('Session archived', {
            action: { label: 'Undo', kind: 'undo', onPress: () => t.info('Restored') },
          }),
      },
      {
        label: 'Undo · removed from queue',
        icon: TrashIcon,
        fire: (t) =>
          t.info('Removed from queue', {
            action: { label: 'Undo', kind: 'undo', onPress: () => t.info('Restored') },
          }),
      },
    ],
  },
  {
    title: 'Schedules',
    cases: [
      {
        label: 'Fired',
        icon: ClockIcon,
        fire: (t) => t.success('Schedule fired', { entity: SCHEDULE }),
      },
      {
        label: 'Queued',
        icon: ClockIcon,
        fire: (t) => t.success('Schedule queued', { entity: SCHEDULE }),
      },
      {
        label: 'Unable to fire',
        icon: ClockIcon,
        fire: (t) =>
          t.error('Unable to fire the schedule', {
            entity: SCHEDULE,
            description: 'The agent "analyst" no longer exists.',
          }),
      },
      {
        label: 'Warning on a schedule',
        icon: ClockIcon,
        fire: (t) =>
          t.warning('Schedule is failing', { entity: SCHEDULE, description: 'The last 3 runs failed.' }),
      },
      {
        label: 'Webhook',
        icon: WebhooksLogoIcon,
        fire: (t) =>
          t.success('Webhook created', {
            entity: { icon: WebhooksLogoIcon, label: 'Stripe payment webhook' },
            description: 'Copy its address to finish setup.',
          }),
      },
      {
        label: 'App event',
        icon: LightningIcon,
        fire: (t) =>
          t.success('App event created', { entity: { icon: LightningIcon, label: 'New Linear issue' } }),
      },
    ],
  },
  {
    title: 'Loading',
    cases: [
      {
        label: 'Loading → success (2 s)',
        icon: CheckCircleIcon,
        fire: (t) =>
          void t.promise(wait(2000), { loading: 'Indexing files…', success: 'Indexed 342 files' }),
      },
      {
        label: 'Loading → error (2 s)',
        icon: XCircleIcon,
        fire: (t) =>
          void t
            .promise(
              wait(2000).then(() => Promise.reject(new Error('Connection refused'))),
              { loading: 'Connecting…', success: 'Connected', error: (e) => (e as Error).message },
            )
            .catch(noop),
      },
      {
        label: 'Stack · three at once',
        icon: InfoIcon,
        fire: (t) => {
          t.success('Schedule fired', { entity: SCHEDULE });
          setTimeout(() => t.info('Message copied'), 300);
          setTimeout(() => t.error('Upload failed', { description: 'report-q3.pdf is larger than 50 MB.' }), 600);
        },
      },
    ],
  },
];

export function ToastDebugScreen() {
  const toast = useToast();
  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title="Toasts" />
      <SettingsPage>
        {GROUPS.map((group) => (
          <SettingsGroup key={group.title} title={group.title}>
            {group.cases.map((c) => (
              <SettingsRow key={c.label} icon={c.icon} label={c.label} onPress={() => c.fire(toast)} />
            ))}
          </SettingsGroup>
        ))}
      </SettingsPage>
    </View>
  );
}
