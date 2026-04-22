/**
 * File Item Component
 * Reusable file/folder item with beautiful animations
 * Matches SelectableListItem design pattern from AgentDrawer
 */

import React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Folder,
  FolderOpen,
  File,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileMusic,
  FileCode,
  FileCode2,
  FileJson,
  FileCog,
  FileTerminal,
  FileSpreadsheet,
  FileType,
  FileArchive,
  FileLock,
  FileBox,
  FileKey,
  FileBadge,
  FileChartLine,
  Database,
  ChevronRight,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import type { SandboxFile } from '@/api/types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type IconComponent = typeof File;

function getBasename(name: string): string {
  return name.toLowerCase();
}

function getExt(name: string): string {
  const base = getBasename(name);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : '';
}

/**
 * Muted foreground color matching the mobile app's --muted-foreground token.
 * Mirrors web's `text-muted-foreground` usage on file icons.
 */
export function getMutedIconColor(isDark: boolean): string {
  return isDark ? '#a1a1aa' : '#71717a';
}

/**
 * Returns a Lucide icon component for the given file, mirroring the web
 * `getFileIcon` mapping (Google Drive-style monochrome icons).
 *
 * The returned icon is rendered with a muted color by callers — this helper
 * only picks the right glyph.
 */
export function getFileIconComponent(
  file: SandboxFile,
  options: { isOpen?: boolean } = {},
): IconComponent {
  if (file.type === 'directory') {
    return options.isOpen ? FolderOpen : Folder;
  }

  const name = getBasename(file.name);
  const ext = getExt(file.name);

  // ── Special filenames ──────────────────────────────────────────
  if (name === 'dockerfile' || name.startsWith('docker-compose')) return FileBox;
  if (name === '.env' || name.startsWith('.env.')) return FileKey;
  if (['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].includes(name)) return FileBox;
  if (['license', 'license.md', 'license.txt'].includes(name)) return FileBadge;
  if (['.gitignore', '.gitattributes', '.gitmodules'].includes(name)) return FileCog;
  if (['makefile', 'cmakelists.txt'].includes(name)) return FileTerminal;

  // ── By extension ───────────────────────────────────────────────

  // JS/TS family
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) return FileCode2;

  // Other code languages + markup
  if ([
    'py', 'pyi', 'pyx', 'pyw', 'rs', 'go', 'rb', 'erb', 'gemspec',
    'java', 'kt', 'kts', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
    'm', 'mm', 'cs', 'swift', 'php', 'lua', 'hs', 'lhs', 'r', 'rmd',
    'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
    'xml', 'xsl', 'xslt', 'wsdl',
  ].includes(ext)) return FileCode;

  // Data / config
  if (['json', 'jsonc', 'json5'].includes(ext)) return FileJson;
  if (['yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'editorconfig'].includes(ext)) return FileCog;

  // Shell
  if (['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd', 'ps1'].includes(ext)) return FileTerminal;

  // Text / docs
  if (['md', 'mdx', 'txt', 'rst', 'rtf', 'log'].includes(ext)) return FileText;

  // Images
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif', 'tiff', 'tif', 'heic', 'heif'].includes(ext)) return FileImage;

  // Video
  if (['mp4', 'webm', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'ogv'].includes(ext)) return FileVideo;

  // Audio
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus'].includes(ext)) return FileAudio;
  if (['mid', 'midi'].includes(ext)) return FileMusic;

  // Spreadsheets
  if (['xlsx', 'xls', 'csv', 'tsv', 'ods'].includes(ext)) return FileSpreadsheet;

  // Databases
  if (['db', 'sqlite', 'sqlite3', 'db3', 'sdb', 's3db'].includes(ext)) return Database;
  if (ext === 'sql') return FileChartLine;

  // PDF / Documents
  if (['pdf', 'doc', 'docx', 'odt', 'ppt', 'pptx', 'odp'].includes(ext)) return FileType;

  // Archives
  if (['zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'tgz', 'zst'].includes(ext)) return FileArchive;

  // Lock / security
  if (['lock', 'pem', 'crt', 'cer', 'key'].includes(ext)) return FileLock;

  // Protobuf / GraphQL
  if (['proto', 'graphql', 'gql'].includes(ext)) return FileCode2;

  // WASM
  if (['wasm', 'wat'].includes(ext)) return FileBox;

  // Config dotfiles
  if (name.startsWith('.') && (name.endsWith('rc') || name.endsWith('rc.js') || name.endsWith('rc.json') || name.endsWith('rc.yml'))) return FileCog;
  if (name.includes('eslint') || name.includes('prettier') || name.includes('babel')) return FileCog;
  if (name.startsWith('tsconfig') || name.startsWith('jsconfig')) return FileCog;

  return File;
}

/**
 * Backwards-compatible helper returning a Lucide icon and a muted color.
 * The color is theme-aware and mirrors web's `text-muted-foreground` look.
 */
export function getFileIconAndColor(
  file: SandboxFile,
  isDark: boolean,
): { icon: IconComponent; color: string } {
  return { icon: getFileIconComponent(file), color: getMutedIconColor(isDark) };
}

interface FileItemProps {
  file: SandboxFile;
  onPress: (file: SandboxFile) => void;
  onLongPress?: (file: SandboxFile) => void;
}

/**
 * File Item Component
 */
export function FileItem({ file, onPress, onLongPress }: FileItemProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress(file);
  };

  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onLongPress?.(file);
  };

  const { icon: IconComponent, color: iconColor } = getFileIconAndColor(file, isDark);

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={animatedStyle}
      className="flex-row items-center justify-between active:opacity-70 py-2"
      accessibilityRole="button"
      accessibilityLabel={file.type === 'directory' ? `Folder ${file.name}` : `File ${file.name}`}
    >
      {/* Left: Icon + Text */}
      <View className="flex-row items-center gap-3 flex-1 min-w-0">
        {/* Icon — monochrome, matches web file-icon (no background container) */}
        <View className="w-6 items-center justify-center flex-shrink-0">
          <Icon
            as={IconComponent}
            size={22}
            color={iconColor}
            strokeWidth={1.75}
          />
        </View>

        {/* Text Content */}
        <View className="flex-1 min-w-0">
          <Text
            style={{ color: isDark ? '#f8f8f8' : '#121215' }}
            className="text-base font-roobert-medium"
            numberOfLines={1}
          >
            {file.name}
          </Text>
          {file.type === 'directory' && (
            <Text
              style={{ color: isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
              className="text-xs font-roobert mt-0.5"
            >
              Folder
            </Text>
          )}
        </View>
      </View>

      {/* Right: Chevron */}
      <Icon
        as={ChevronRight}
        size={20}
        color={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)'}
        strokeWidth={2}
        className="flex-shrink-0"
      />
    </AnimatedPressable>
  );
}

