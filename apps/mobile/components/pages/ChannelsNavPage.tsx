/**
 * ChannelsNavPage — connect a project to Slack (web parity:
 * customize/sections/channels-view). Two paths: 1-click OAuth ("Add to Slack")
 * when the server has Slack creds, or BYO (paste a bot token + signing secret
 * from your own Slack app built from the generated manifest).
 *
 * Mobile branding: PageHeader + PageContent chrome, a bottom-sheet BYO wizard,
 * design-system typography + colors.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import {
  MessageSquare,
  Check,
  Copy,
  ExternalLink,
  Trash2,
  X,
  Plug,
  CircleCheck,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import {
  useSlackInstallation,
  useSlackMode,
  useConnectSlack,
  useDisconnectSlack,
} from '@/lib/projects/hooks';
import { API_URL } from '@/api/config';
import { haptics } from '@/lib/haptics';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface ChannelsNavPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const MONO = 'Menlo';
const SLACK_APPS_URL = 'https://api.slack.com/apps?new_app=1';
const SLACK = '#611f69';

function buildSlackManifest(projectId: string): string {
  const root = API_URL.replace(/\/v1\/?$/, '');
  const requestUrl = `${root}/v1/webhooks/slack/${projectId}`;
  const manifest = {
    display_information: {
      name: 'Kortix',
      description: 'Run a Kortix project from Slack',
      background_color: '#0a0a0a',
    },
    features: { bot_user: { display_name: 'kortix', always_online: true } },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read', 'channels:history', 'channels:read', 'channels:join',
          'chat:write', 'chat:write.public', 'files:read', 'files:write',
          'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write',
          'mpim:history', 'mpim:read', 'reactions:read', 'reactions:write', 'users:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [
          'app_mention', 'message.im', 'message.channels', 'message.groups',
          'message.mpim', 'reaction_added', 'reaction_removed',
          'member_joined_channel', 'file_shared',
        ],
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
  return JSON.stringify(manifest, null, 2);
}

// ─── BYO wizard (manifest → tokens) ───────────────────────────────────────────

function ByoSlackSheet({
  projectId,
  onClose,
  isDark,
}: {
  projectId: string;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const connectMut = useConnectSlack(projectId);

  const [step, setStep] = useState<'manifest' | 'tokens'>('manifest');
  const [copied, setCopied] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const manifest = useMemo(() => buildSlackManifest(projectId), [projectId]);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  const copyManifest = async () => {
    haptics.tap();
    await Clipboard.setStringAsync(manifest);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const canConnect = botToken.trim().length > 0 && signingSecret.trim().length > 0 && !connectMut.isPending;

  const handleConnect = () => {
    if (!canConnect) return;
    setErrMsg(null);
    haptics.tap();
    connectMut.mutate(
      { bot_token: botToken.trim(), signing_secret: signingSecret.trim() },
      {
        onSuccess: () => { haptics.success(); onClose(); },
        onError: (err: any) => setErrMsg(err?.message || 'Could not connect Slack.'),
      },
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>Bring your own Slack app</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      {/* Step indicator */}
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 12 }}>
        {(['manifest', 'tokens'] as const).map((s, i) => (
          <View key={s} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: (step === 'tokens' || i === 0) ? theme.primary : border }} />
        ))}
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {step === 'manifest' ? (
          <>
            <Text style={{ fontSize: 13.5, lineHeight: 20, color: muted, marginBottom: 14 }}>
              1. Copy this app manifest. 2. Open Slack and create an app “from a manifest”, paste it, and install to your workspace.
            </Text>

            <TouchableOpacity
              onPress={copyManifest}
              activeOpacity={0.8}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 9999, backgroundColor: theme.primary, marginBottom: 10 }}
            >
              {copied ? <CircleCheck size={16} color={theme.primaryForeground} /> : <Copy size={16} color={theme.primaryForeground} />}
              <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>{copied ? 'Copied' : 'Copy manifest'}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => { haptics.tap(); WebBrowser.openBrowserAsync(SLACK_APPS_URL); }}
              activeOpacity={0.8}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 9999, borderWidth: 1, borderColor: border, marginBottom: 16 }}
            >
              <ExternalLink size={16} color={fg} />
              <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: fg }}>Open Slack apps</Text>
            </TouchableOpacity>

            <View style={{ borderRadius: 12, borderWidth: 1, borderColor: border, backgroundColor: inputBg, padding: 12 }}>
              <Text style={{ fontSize: 11.5, lineHeight: 17, fontFamily: MONO, color: muted }}>{manifest}</Text>
            </View>
          </>
        ) : (
          <>
            <Text style={{ fontSize: 13.5, lineHeight: 20, color: muted, marginBottom: 16 }}>
              From your Slack app: paste the Bot User OAuth Token (OAuth & Permissions) and the Signing Secret (Basic Information → App Credentials).
            </Text>

            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Bot User OAuth Token</Text>
            <BottomSheetTextInput
              value={botToken}
              onChangeText={setBotToken}
              placeholder="xoxb-…"
              placeholderTextColor={muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: MONO, marginBottom: 14 }}
            />

            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Signing Secret</Text>
            <BottomSheetTextInput
              value={signingSecret}
              onChangeText={setSigningSecret}
              placeholder="••••••••••••"
              placeholderTextColor={muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' }}
            />

            {errMsg && (
              <View style={{ marginTop: 14, padding: 12, borderRadius: 11, backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
                <Text style={{ fontSize: 13, color: '#ef4444' }}>{errMsg}</Text>
              </View>
            )}
          </>
        )}
      </BottomSheetScrollView>

      <View style={{ flexDirection: 'row', gap: 10, padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        {step === 'tokens' && (
          <TouchableOpacity
            onPress={() => { haptics.tap(); setStep('manifest'); }}
            activeOpacity={0.8}
            style={{ paddingHorizontal: 20, height: 48, borderRadius: 9999, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center' }}
          >
            <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>Back</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={() => {
            if (step === 'manifest') { haptics.tap(); setStep('tokens'); }
            else handleConnect();
          }}
          disabled={step === 'tokens' && !canConnect}
          activeOpacity={0.85}
          style={{ flex: 1, height: 48, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: step === 'tokens' && !canConnect ? 0.5 : 1 }}
        >
          {connectMut.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>
            {step === 'manifest' ? 'I installed it — next' : 'Connect Slack'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono, isDark }: { label: string; value: string; mono?: boolean; isDark: boolean }) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: border }}>
      <Text style={{ fontSize: 13, color: muted }}>{label}</Text>
      <Text style={{ flex: 1, textAlign: 'right', fontSize: 13.5, fontFamily: mono ? MONO : 'Roobert-Medium', color: fg }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export function ChannelsNavPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: ChannelsNavPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const byoSheetRef = React.useRef<BottomSheetModal>(null);

  const install = useSlackInstallation(projectId);
  const mode = useSlackMode(projectId);
  const disconnectMut = useDisconnectSlack(projectId);

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const cardBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';

  const installed = install.data ?? null;
  const oauth = mode.data?.oauth_available ?? false;
  const loading = install.isLoading || mode.isLoading;

  const handleAddToSlack = async () => {
    const url = mode.data?.install_url;
    if (!url) return;
    haptics.tap();
    await WebBrowser.openBrowserAsync(url);
    // No callback hook — poll the installation a few times after returning.
    for (let i = 0; i < 5; i++) {
      const res = await install.refetch();
      if (res.data) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect Slack',
      'Removes the Slack secrets and stops events for this project.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect', style: 'destructive', onPress: () => {
            haptics.medium();
            disconnectMut.mutate(undefined, {
              onError: (err: any) => Alert.alert('Failed', err?.message || 'Could not disconnect.'),
            });
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
        >
          {loading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}>
              <ActivityIndicator size="small" color={muted} />
            </View>
          ) : installed ? (
            <>
              {/* Connected */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(34,197,94,0.3)', backgroundColor: 'rgba(34,197,94,0.08)' }}>
                <View style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: SLACK, alignItems: 'center', justifyContent: 'center' }}>
                  <MessageSquare size={20} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
                    Connected to {installed.workspaceName ?? installed.workspaceId}
                  </Text>
                  <Text style={{ fontSize: 12.5, color: '#16a34a', marginTop: 2 }}>Slack is receiving events</Text>
                </View>
                <CircleCheck size={20} color="#16a34a" />
              </View>

              <View style={{ marginTop: 16, borderRadius: 14, borderWidth: 1, borderColor: border, paddingHorizontal: 14 }}>
                <InfoRow label="Bot user" value={installed.botUserId ?? '—'} mono isDark={isDark} />
                <InfoRow label="Workspace ID" value={installed.workspaceId} mono isDark={isDark} />
                <InfoRow label="Installed" value={new Date(installed.installedAt).toLocaleDateString()} isDark={isDark} />
              </View>

              <View style={{ marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: cardBg }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 6 }}>How to use it</Text>
                <Text style={{ fontSize: 13, lineHeight: 19, color: muted }}>
                  Invite the bot to a channel, then @mention it to start a run. It can also reply in DMs.
                </Text>
              </View>

              <TouchableOpacity
                onPress={handleDisconnect}
                disabled={disconnectMut.isPending}
                activeOpacity={0.7}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 22, height: 48, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', opacity: disconnectMut.isPending ? 0.5 : 1 }}
              >
                {disconnectMut.isPending ? <ActivityIndicator size="small" color="#ef4444" /> : <Trash2 size={15} color="#ef4444" />}
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Disconnect Slack</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {/* Disconnected */}
              <View style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 20 }}>
                <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: SLACK, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                  <MessageSquare size={28} color="#fff" />
                </View>
                <Text style={{ fontSize: 17, fontFamily: 'Roobert-Medium', color: fg }}>Connect Slack</Text>
                <Text style={{ fontSize: 13.5, lineHeight: 20, color: muted, textAlign: 'center', marginTop: 6, paddingHorizontal: 12 }}>
                  Run this project from Slack — @mention the bot in a channel or DM it to kick off a session.
                </Text>
              </View>

              {oauth && (
                <TouchableOpacity
                  onPress={handleAddToSlack}
                  activeOpacity={0.85}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 9999, backgroundColor: SLACK }}
                >
                  <MessageSquare size={18} color="#fff" />
                  <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: '#fff' }}>Add to Slack</Text>
                </TouchableOpacity>
              )}

              {oauth && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 18 }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: border }} />
                  <Text style={{ fontSize: 12, color: muted }}>or</Text>
                  <View style={{ flex: 1, height: 1, backgroundColor: border }} />
                </View>
              )}

              <TouchableOpacity
                onPress={() => { haptics.tap(); byoSheetRef.current?.present(); }}
                activeOpacity={0.85}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 50, borderRadius: 9999, borderWidth: 1, borderColor: border, marginTop: oauth ? 0 : 4 }}
              >
                <Plug size={17} color={fg} />
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>Bring your own Slack app</Text>
              </TouchableOpacity>

              <Text style={{ fontSize: 12.5, lineHeight: 18, color: muted, textAlign: 'center', marginTop: 14 }}>
                {oauth
                  ? 'Add to Slack uses our Slack app. Bring your own to keep full control of scopes and tokens.'
                  : 'Build a Slack app from the generated manifest, then paste its bot token and signing secret.'}
              </Text>
            </>
          )}
        </ScrollView>
      </PageContent>

      <BottomSheetModal
        ref={byoSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        <ByoSlackSheet projectId={projectId} onClose={() => byoSheetRef.current?.dismiss()} isDark={isDark} />
      </BottomSheetModal>
    </View>
  );
}
