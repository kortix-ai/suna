/**
 * ConfigEntriesPage — the list and the detail shared by the Agents page and the
 * Skills page (web parity: customize/agents and customize/skills). Both list
 * files of the project repo (`.kortix/opencode/agents/*`, `…/skills/*`) and
 * show a file's markdown source. Authoring flows through a session: the
 * header's `+` and the detail's Edit start one (`onConfigure`).
 *
 * List (Jay, 2026-09-21): no icon tile on a row. A row is two lines: the name,
 * then the description on one line below it (an agent's line starts with its
 * mode: `Primary · description`). The default agent carries a filled star
 * before the chevron.
 *
 * Detail: the entry's name is the page title, and the header's Go back returns
 * to the list (Android back too). Copy and Edit are header buttons. No file
 * path. The mode is a `Badge`. "Set as default agent" is a settings row under
 * the description; the default agent shows it checked.
 *
 * Both scroll views fade at both ends (`scroll-fade`): `BottomFade` always,
 * `TopFade` once the content has scrolled under the header.
 */
import * as React from 'react';
import { BackHandler, Platform, View } from 'react-native';
import Animated from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BOTTOM_FADE_HEIGHT,
  BottomFade,
  TopFade,
  useScrollFade,
} from '@/components/kortix/scroll-fade';
import { ListRow } from '@/components/kortix/list-row';
import { PageContent } from '@/components/kortix/page-content';
import { PageList } from '@/components/kortix/page-list';
import { PageHeader } from '@/components/kortix/page-header';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { SelectableMarkdownText } from '@/components/kortix/selectable-markdown';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { CaretRightIcon, CheckIcon, CopyIcon, PencilIcon, StarIcon } from '@/lib/icons';
import { editConfigPrompt, newConfigPrompt, type ConfigureKind } from '@/lib/projects/configure-prompts';
import { useProjectFile } from '@/lib/projects/hooks';
import { THEME } from '@/lib/utils/theme';

export interface ConfigEntry {
  name: string;
  path: string;
  description?: string | null;
  /** Agents only: `primary`, `subagent`, `all`. */
  mode?: string | null;
}

interface ConfigEntriesPageProps {
  kind: ConfigureKind;
  title: string;
  projectId: string;
  entries: ConfigEntry[];
  isLoading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  /** "agents" / "skills": the search placeholder and the empty lines. */
  noun: string;
  /** Agents: the project's default agent, and the call that sets it. */
  defaultName?: string | null;
  onSetDefault?: (name: string) => void;
  settingDefault?: boolean;
  onConfigure: (prompt: string) => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isRightDrawerOpen?: boolean;
}

/** Strip a leading YAML frontmatter block: the body is what reads as a prompt. */
function stripFrontmatter(source: string): string {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (match ? source.slice(match[0].length) : source).trim();
}

function modeLabel(mode: string | null | undefined): string | null {
  if (!mode) return null;
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function ConfigEntriesPage({
  kind,
  title,
  projectId,
  entries,
  isLoading,
  errorMessage,
  onRetry,
  noun,
  defaultName = null,
  onSetDefault,
  settingDefault = false,
  onConfigure,
  onOpenDrawer,
  onOpenRightDrawer,
  isRightDrawerOpen,
}: ConfigEntriesPageProps) {
  const [search, setSearch] = React.useState('');
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  // Read from the live list, so a new default shows on the open detail.
  const selected = React.useMemo(
    () => entries.find((entry) => entry.path === selectedPath) ?? null,
    [entries, selectedPath],
  );

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) ||
        (entry.description ?? '').toLowerCase().includes(query),
    );
  }, [entries, search]);

  // Android back closes the detail before it leaves the page. Registered after
  // ProjectScreen's handler, so it runs first.
  React.useEffect(() => {
    if (Platform.OS !== 'android' || !selected) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelectedPath(null);
      return true;
    });
    return () => subscription.remove();
  }, [selected]);

  if (selected) {
    return (
      <EntryDetail
        kind={kind}
        projectId={projectId}
        entry={selected}
        isDefault={selected.name === defaultName}
        onSetDefault={onSetDefault}
        settingDefault={settingDefault}
        onBack={() => setSelectedPath(null)}
        onConfigure={onConfigure}
        onOpenRightDrawer={onOpenRightDrawer}
        isRightDrawerOpen={isRightDrawerOpen}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        title={title}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isRightDrawerOpen={isRightDrawerOpen}
        onAdd={() => {
          haptics.tap();
          onConfigure(newConfigPrompt(kind));
        }}
        addLabel={`New ${kind}`}
      />
      <PageContent>
        <SearchListHeader value={search} onChangeText={setSearch} placeholder={`Search ${noun}`} />
        <PageList
          isLoading={isLoading}
          errorMessage={errorMessage}
          onRetry={onRetry}
          emptyLabel={
            filtered.length === 0 ? (entries.length === 0 ? `No ${noun} yet` : `No matching ${noun}`) : null
          }>
          {filtered.map((entry, index) => (
            <ListRow
              key={entry.path}
              title={entry.name}
              subtitle={[modeLabel(entry.mode), entry.description].filter(Boolean).join(' · ')}
              divider={index < filtered.length - 1}
              onPress={() => {
                haptics.tap();
                setSelectedPath(entry.path);
              }}
              right={
                <View className="flex-row items-center gap-2">
                  {entry.name === defaultName ? (
                    <StarIcon size={14} color={THEME.accent.orange} weight="fill" />
                  ) : null}
                  <Icon as={CaretRightIcon} size={18} className="text-muted-foreground" />
                </View>
              }
            />
          ))}
        </PageList>
      </PageContent>
    </View>
  );
}

function EntryDetail({
  kind,
  projectId,
  entry,
  isDefault,
  onSetDefault,
  settingDefault,
  onBack,
  onConfigure,
  onOpenRightDrawer,
  isRightDrawerOpen,
}: {
  kind: ConfigureKind;
  projectId: string;
  entry: ConfigEntry;
  isDefault: boolean;
  onSetDefault?: (name: string) => void;
  settingDefault: boolean;
  onBack: () => void;
  onConfigure: (prompt: string) => void;
  onOpenRightDrawer?: () => void;
  isRightDrawerOpen?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const scrollFade = useScrollFade();
  const { colorScheme } = useColorScheme();
  const toast = useToast();
  const [copied, setCopied] = React.useState(false);
  const fileQuery = useProjectFile(projectId, entry.path);
  const source = fileQuery.data?.content ?? '';
  const body = React.useMemo(() => stripFrontmatter(source), [source]);
  const mode = modeLabel(entry.mode);
  // A subagent never runs a session on its own, so it cannot be the default.
  const showDefaultRow = !!onSetDefault && entry.mode !== 'subagent';

  const handleCopy = React.useCallback(async () => {
    if (!source) return;
    haptics.tap();
    try {
      await Clipboard.setStringAsync(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Unable to copy');
    }
  }, [source, toast]);

  return (
    <View className="flex-1 bg-background">
      <PageHeader
        title={entry.name}
        onBack={() => {
          haptics.tap();
          onBack();
        }}
        onOpenRightDrawer={onOpenRightDrawer}
        isRightDrawerOpen={isRightDrawerOpen}
        rightActions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              disabled={!source}
              onPress={handleCopy}
              accessibilityLabel={copied ? 'Copied' : `Copy ${kind} source`}>
              <Icon as={copied ? CheckIcon : CopyIcon} size={20} className="text-foreground" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onPress={() => {
                haptics.tap();
                onConfigure(editConfigPrompt(kind, entry.name, entry.path));
              }}
              accessibilityLabel={`Edit ${kind}`}>
              <Icon as={PencilIcon} size={20} className="text-foreground" />
            </Button>
          </>
        }
      />
      <PageContent>
        <View className="flex-1">
          <Animated.ScrollView
            onScroll={scrollFade.onScroll}
            scrollEventThrottle={16}
            className="flex-1"
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 4,
              paddingBottom: BOTTOM_FADE_HEIGHT + insets.bottom,
              gap: 16,
            }}
            showsVerticalScrollIndicator={false}>
            {mode || entry.description ? (
              <View className="gap-2">
                {mode ? (
                  <Badge variant="secondary" className="self-start">
                    <Text>{mode}</Text>
                  </Badge>
                ) : null}
                {entry.description ? <Text variant="muted">{entry.description}</Text> : null}
              </View>
            ) : null}

            {showDefaultRow ? (
              <SettingsGroup>
                {isDefault ? (
                  // The list's filled star, so the default reads the same in both places.
                  <SettingsRow
                    leading={<StarIcon size={18} color={THEME.accent.orange} weight="fill" />}
                    label="Default agent"
                    checked
                  />
                ) : (
                  <SettingsRow
                    icon={StarIcon}
                    label={settingDefault ? 'Setting as default…' : 'Set as default agent'}
                    right={null}
                    onPress={settingDefault ? undefined : () => onSetDefault?.(entry.name)}
                  />
                )}
              </SettingsGroup>
            ) : null}

            {fileQuery.isLoading ? (
              <View className="gap-3">
                <Skeleton className="h-4 w-3/4 rounded-md" />
                <Skeleton className="h-4 w-full rounded-md" />
                <Skeleton className="h-4 w-5/6 rounded-md" />
              </View>
            ) : fileQuery.isError ? (
              <Text variant="muted">
                {(fileQuery.error as Error)?.message ?? `Unable to read the ${kind} source`}
              </Text>
            ) : body ? (
              <SelectableMarkdownText isDark={colorScheme === 'dark'}>{body}</SelectableMarkdownText>
            ) : (
              <Text variant="muted">No prompt body</Text>
            )}
          </Animated.ScrollView>
          <TopFade style={scrollFade.topFadeStyle} />
          <BottomFade />
        </View>
      </PageContent>
    </View>
  );
}
