/**
 * ProjectPicker — mobile port of the web dashboard ProjectSelector
 * (apps/web/src/components/dashboard/project-selector.tsx).
 *
 * Renders:
 *  - a compact pill with the active project's name + chevron (same look as
 *    the web trigger button).
 *  - a BottomSheet (dynamic-sized, no X close) with a search field, a
 *    "Default project" row, and the list of recent projects sorted by
 *    recency with checkmark on the selection.
 *
 * Selection is persisted via useSelectedProjectStore so it survives app
 * restarts, matching web behavior.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { CheckIcon as Check, CaretUpIcon as ChevronUp, MagnifyingGlassIcon as SearchIcon } from '@/lib/icons';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { THEME, withAlpha } from '@/lib/utils/theme';
import {
  useKortixProjects,
  type KortixProject,
} from '@/lib/kortix/use-kortix-projects';
import { useSelectedProjectStore } from '@/stores/selected-project-store';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { SheetBackdrop, useSheetBackground, KortixBottomSheetModal } from '@/components/kortix/sheet';

// ─── Helpers (mirror of web) ─────────────────────────────────────────────────

function projectRecency(p: KortixProject): number {
  if (p.time?.updated) return p.time.updated;
  if (p.created_at) {
    const t = new Date(p.created_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function shortPath(path: string | undefined): string {
  if (!path || path === '/') return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ProjectPicker() {
  const sheetBg = useSheetBackground();
  const { sandboxUrl } = useSandboxContext();
  const { data: projects, isLoading } = useKortixProjects(sandboxUrl);
  const selectedProjectId = useSelectedProjectStore((s) => s.projectId);
  const setSelectedProjectId = useSelectedProjectStore((s) => s.setProjectId);

  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const sheetRef = useRef<BottomSheetModal>(null);
  const [search, setSearch] = useState('');

  // Sort by recency (desc), same as web.
  const sorted = useMemo(() => {
    if (!projects) return [] as KortixProject[];
    return [...projects].sort((a, b) => projectRecency(b) - projectRecency(a));
  }, [projects]);

  // Filter by search query (name/path/description/id).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((p) => {
      const hay = [p.name, p.path, p.description, p.id].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [sorted, search]);

  const selected = useMemo(
    () => sorted.find((p) => p.id === selectedProjectId) ?? null,
    [sorted, selectedProjectId],
  );

  // If the selected id vanishes from the server (project deleted), clear it —
  // same self-heal the web does in session-chat.
  useEffect(() => {
    if (selectedProjectId && projects && !selected) {
      setSelectedProjectId(null);
    }
  }, [selectedProjectId, projects, selected, setSelectedProjectId]);

  const displayName = selected?.name ?? 'Default project';
  const hasProjects = sorted.length > 0;

  const open = useCallback(() => {
    setSearch('');
    sheetRef.current?.present();
  }, []);

  const close = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);


  // Tokens — same neutral palette as Actions / Config sheets.
  const bg = sheetBg;
  const fgColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const mutedColor = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const selectedBg = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05);
  const dividerColor = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08);
  const pillBg = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05);

  return (
    <>
      {/* Trigger pill — compact, centered. Clicking opens the sheet. */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'center',
          paddingVertical: 6,
        }}
      >
        <Button
          variant="ghost"
          onPress={open}
          disabled={isLoading && !hasProjects}
          className="h-auto w-auto active:bg-transparent active:opacity-70"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            height: 32,
            paddingLeft: 12,
            paddingRight: 10,
            borderRadius: 16,
            backgroundColor: selected ? pillBg : 'transparent',
            borderWidth: 1,
            borderColor: dividerColor,
            maxWidth: 260,
          }}
        >
          <Text
            style={{
              fontSize: 13,
              fontFamily: 'Roobert-Medium',
              color: selected ? fgColor : mutedColor,
              flexShrink: 1,
              marginRight: 6,
            }}
            numberOfLines={1}
          >
            {displayName}
          </Text>
          <Icon
            as={ChevronUp}
            size={12}
            color={mutedColor}
          />
        </Button>
      </View>

      {/* Picker sheet */}
      <KortixBottomSheetModal
        title="Project"
        ref={sheetRef}
        enableDynamicSizing
        maxDynamicContentSize={560}
        enablePanDownToClose
        enableOverDrag={false}
        backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}
      >
        <BottomSheetScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
          showsVerticalScrollIndicator={false}
          stickyHeaderIndices={[0]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Sticky block: title + search field. Solid bg so rows don't
              bleed through while scrolled. */}
          <View style={{ backgroundColor: bg }}>

            <View style={{ marginHorizontal: 20, marginBottom: 10 }}>
              <View
                pointerEvents="none"
                style={{ position: 'absolute', left: 14, top: 0, bottom: 0, justifyContent: 'center', zIndex: 1 }}
              >
                <Icon as={SearchIcon} size={14} color={mutedColor} />
              </View>
              <SheetTextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search projects..."
                autoCapitalize="none"
                autoCorrect={false}
                style={{ height: 40, paddingLeft: 36 }}
              />
            </View>
          </View>

          {/* Default (no override) — only when search is empty, matches web. */}
          {!search.trim() && (
            <Button
              variant="ghost"
              onPress={() => {
                setSelectedProjectId(null);
                close();
              }}
              className="h-auto w-auto flex-row items-center justify-start rounded-none active:opacity-70"
              style={{
                paddingHorizontal: 20,
                paddingVertical: 12,
                backgroundColor: !selectedProjectId ? selectedBg : 'transparent',
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontSize: 15,
                    fontFamily: 'Roobert-Medium',
                    color: fgColor,
                  }}
                  numberOfLines={1}
                >
                  Default project
                </Text>
                <Text
                  style={{
                    marginTop: 2,
                    fontSize: 12,
                    fontFamily: 'Roobert',
                    color: mutedColor,
                  }}
                  numberOfLines={1}
                >
                  Use the current working directory
                </Text>
              </View>
              {!selectedProjectId && (
                <Icon as={Check} size={16} color={fgColor} />
              )}
            </Button>
          )}

          {/* Recent projects list */}
          {filtered.length > 0 && (
            <View>
              <Text
                style={{
                  paddingHorizontal: 20,
                  paddingTop: 12,
                  paddingBottom: 6,
                  fontSize: 11,
                  fontFamily: 'Roobert-SemiBold',
                  color: mutedColor,
                  textTransform: 'uppercase',
                  letterSpacing: 0.8,
                }}
              >
                Recent projects
              </Text>
              {filtered.map((project) => {
                const isSelected = selectedProjectId === project.id;
                const recency = projectRecency(project);
                const pathLabel = shortPath(project.path);
                const relLabel = recency > 0 ? formatRelativeTime(recency) : '';
                const subtitleParts = [pathLabel, relLabel].filter(Boolean);
                return (
                  <Button
                    key={project.id}
                    variant="ghost"
                    onPress={() => {
                      setSelectedProjectId(project.id);
                      close();
                    }}
                    className="h-auto w-auto flex-row items-center justify-start rounded-none active:opacity-70"
                    style={{
                      paddingHorizontal: 20,
                      paddingVertical: 12,
                      backgroundColor: isSelected ? selectedBg : 'transparent',
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={{
                          fontSize: 15,
                          fontFamily: 'Roobert-Medium',
                          color: fgColor,
                        }}
                        numberOfLines={1}
                      >
                        {project.name}
                      </Text>
                      {subtitleParts.length > 0 && (
                        <Text
                          style={{
                            marginTop: 2,
                            fontSize: 12,
                            fontFamily: 'Roobert',
                            color: mutedColor,
                          }}
                          numberOfLines={1}
                        >
                          {subtitleParts.join(' · ')}
                        </Text>
                      )}
                    </View>
                    {isSelected && (
                      <Icon as={Check} size={16} color={fgColor} />
                    )}
                  </Button>
                );
              })}
            </View>
          )}

          {/* Empty states */}
          {filtered.length === 0 && search.trim() && (
            <View style={{ paddingVertical: 32, alignItems: 'center' }}>
              <Text style={{ fontSize: 12, color: mutedColor, fontFamily: 'Roobert' }}>
                No projects match “{search.trim()}”
              </Text>
            </View>
          )}
          {!hasProjects && !search.trim() && !isLoading && (
            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
              <Text style={{ fontSize: 12, color: mutedColor, fontFamily: 'Roobert' }}>
                No projects yet
              </Text>
            </View>
          )}
        </BottomSheetScrollView>
      </KortixBottomSheetModal>
    </>
  );
}
