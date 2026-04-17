/**
 * SessionTurn — renders a single user + assistant turn.
 *
 * Mirrors the Computer frontend's SessionTurn component logic.
 */

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { View, TouchableOpacity, Animated, StyleSheet, LayoutAnimation, Platform, UIManager, ScrollView, Image, TextInput } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { SandboxPreviewCard, detectLocalhostUrls } from '@/components/chat/SandboxPreviewCard';
import { ReasoningSection, GroupedReasoningCard } from '@/components/chat';
import ReAnimated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import {
  Terminal,
  FileCode2,
  Search,
  Globe,
  Glasses,
  CheckSquare,
  Cpu,
  SquareKanban,
  ImageIcon,
  Presentation,
  List,
  Scissors,
  MessageCircle,
  ChevronRight,
  ChevronDown,
  Check,
  CircleAlert,
  Loader2,
  ExternalLink,
  FileText,
  MonitorPlay,
  type LucideIcon,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getSandboxPortUrl } from '@/lib/platform/client';
import { getAuthToken } from '@/api/config';
import { FileViewer } from '@/components/files/FileViewer';
import type { SandboxFile } from '@/api/types';
import { useTabStore } from '@/stores/tab-store';
import type {
  Turn,
  MessageWithParts,
  SessionStatus,
  TextPart,
  ToolPart,
  ReasoningPart,
  QuestionRequest,
  Part,
} from '@/lib/opencode/types';
import type { Command } from '@/lib/opencode/hooks/use-opencode-data';
import {
  collectTurnParts,
  findLastTextPart,
  isTextPart,
  isToolPart,
  isReasoningPart,
  isLastUserMessage,
  getWorkingState,
  getTurnError,
  getTurnStatus,
  getToolInfo,
  shouldShowToolPart,
  formatDuration,
  formatCost,
  formatTokens,
  getTurnCost,
  stripAnsi,
  getRetryInfo,
  getRetryMessage,
  splitUserParts,
  isFilePart,
} from '@/lib/opencode/turns';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Image extension detection ──────────────────────────────────────────────

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?|heic|heif)$/i;

function isImagePath(filePath: string): boolean {
  return IMAGE_EXT_RE.test(filePath);
}

// ─── SandboxImage — loads an image from the sandbox with auth ────────────────

function SandboxImage({
  filePath,
  isDark,
  height = 240,
}: {
  filePath: string;
  isDark: boolean;
  height?: number;
}) {
  const { sandboxUrl } = useSandboxContext();
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!sandboxUrl || !filePath) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAuthToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(
          `${sandboxUrl}/file/raw?path=${encodeURIComponent(filePath)}`,
          { headers },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onload = () => {
          if (!cancelled && typeof reader.result === 'string') {
            setImageUri(reader.result);
            setLoading(false);
          }
        };
        reader.onerror = () => {
          if (!cancelled) { setError(true); setLoading(false); }
        };
        reader.readAsDataURL(blob);
      } catch {
        if (!cancelled) { setError(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [sandboxUrl, filePath]);

  if (loading) {
    return (
      <View style={{ height, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)' }}>
        <ReAnimated.View>
          <Loader2 size={20} color={isDark ? '#52525b' : '#a1a1aa'} />
        </ReAnimated.View>
      </View>
    );
  }

  if (error || !imageUri) {
    return (
      <View style={{ height: 60, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 12, color: isDark ? '#71717a' : '#a1a1aa' }}>
          Failed to load image
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri: imageUri }}
      style={{ width: '100%', height, borderBottomLeftRadius: 13, borderBottomRightRadius: 13 }}
      resizeMode="cover"
    />
  );
}

// ─── Shimmer text for status indicators ──────────────────────────────────────

function ShimmerStatusText({ text, size = 'sm' }: { text: string; size?: 'sm' | 'xs' }) {
  const shimmerPosition = useSharedValue(0);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  useEffect(() => {
    shimmerPosition.value = withRepeat(
      withTiming(1, { duration: 2000, easing: Easing.linear }),
      -1,
      false,
    );
  }, []);

  const animatedGradientStyle = useAnimatedStyle(() => {
    const translateX = interpolate(shimmerPosition.value, [0, 1], [-200, 200]);
    return { transform: [{ translateX }] };
  });

  const textColor = isDark ? '#a1a1aa' : '#71717a';
  const shimmerColor = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.35)';
  const fontSize = size === 'xs' ? 12 : 14;
  const lineHeight = size === 'xs' ? 16 : 20;

  return (
    <View style={{ justifyContent: 'center' }}>
      <MaskedView
        maskElement={
          <Text
            style={{
              fontSize,
              lineHeight,
              fontFamily: 'Roobert',
              color: '#000',
            }}
          >
            {text}
          </Text>
        }
      >
        <View style={{ width: Math.max(text.length * (fontSize * 0.6), 80), height: lineHeight }}>
          <View style={[StyleSheet.absoluteFill, { backgroundColor: textColor }]} />
          <ReAnimated.View style={[StyleSheet.absoluteFill, { width: 200 }, animatedGradientStyle]}>
            <LinearGradient
              colors={[textColor, shimmerColor, textColor]}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={{ flex: 1, width: 200 }}
            />
          </ReAnimated.View>
        </View>
      </MaskedView>
    </View>
  );
}

// ─── Tool input resolver ─────────────────────────────────────────────────────
// The SDK sends `input` inside `state.input`, but mobile types define it at `tool.input`.
// At runtime the data may be in either location. This helper checks both.
// During pending/running state, tries to parse the streaming raw field for early labels.

function parsePartialJSON(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    // Try closing open braces for partial JSON
    let patched = raw.trim();
    if (!patched.startsWith('{')) return {};
    // Close unclosed strings
    const quoteCount = (patched.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) patched += '"';
    // Close any open braces
    const opens = (patched.match(/{/g) || []).length;
    const closes = (patched.match(/}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) patched += '}';
    try {
      return JSON.parse(patched);
    } catch {
      return {};
    }
  }
}

function getToolInput(tool: ToolPart): Record<string, any> {
  const stateInput = (tool.state as any)?.input;
  if (stateInput && typeof stateInput === 'object' && Object.keys(stateInput).length > 0) {
    return stateInput;
  }
  // During pending/running state, try to parse the streaming raw field
  if (
    (tool.state.status === 'pending' || tool.state.status === 'running') &&
    'raw' in (tool.state as any)
  ) {
    const raw = (tool.state as any).raw as string;
    if (raw) return parsePartialJSON(raw);
  }
  return tool.input || {};
}


// ─── Tool icon resolver ──────────────────────────────────────────────────────

const TOOL_ICON_MAP: Record<string, LucideIcon> = {
  terminal: Terminal,
  'file-pen': FileCode2,
  search: Search,
  globe: Globe,
  glasses: Glasses,
  'check-square': CheckSquare,
  'square-kanban': SquareKanban,
  image: ImageIcon,
  presentation: Presentation,
  list: List,
  scissors: Scissors,
  'message-circle': MessageCircle,
  cpu: Cpu,
};

function getToolLucideIcon(iconName: string): LucideIcon {
  return TOOL_ICON_MAP[iconName] ?? Cpu;
}

// ─── Shared styles ───────────────────────────────────────────────────────────

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

function cardBorder(isDark: boolean) {
  return isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
}
function cardBg(isDark: boolean) {
  return isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.8)';
}
function mutedBg(isDark: boolean) {
  return isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)';
}
function fg(isDark: boolean) {
  return isDark ? '#F8F8F8' : '#121215';
}
function muted(isDark: boolean) {
  return isDark ? '#71717a' : '#a1a1aa';
}
function mutedStrong(isDark: boolean) {
  return isDark ? '#a1a1aa' : '#71717a';
}

// ─── MonoBlock — reusable monospace code block ───────────────────────────────

function MonoBlock({
  children,
  isDark,
  color,
  maxLines,
}: {
  children: string;
  isDark: boolean;
  color?: string;
  maxLines?: number;
}) {
  return (
    <Text
      numberOfLines={maxLines}
      style={{
        fontSize: 11,
        fontFamily: monoFont,
        lineHeight: 17,
        color: color || mutedStrong(isDark),
      }}
    >
      {children}
    </Text>
  );
}

// ─── OutputSection — "OUTPUT" label + content block ──────────────────────────

function OutputSection({
  output,
  isDark,
  isError,
}: {
  output: string;
  isDark: boolean;
  isError?: boolean;
}) {
  const displayOutput = output.length > 3000 ? output.slice(0, 3000) + '\n...' : output;
  return (
    <View
      style={{
        marginHorizontal: 10,
        marginBottom: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
        backgroundColor: mutedBg(isDark),
        overflow: 'hidden',
      }}
    >
      {/* Label */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 }}>
        <View
          style={{
            width: 5,
            height: 5,
            borderRadius: 2.5,
            backgroundColor: isError ? (isDark ? '#ef4444' : '#dc2626') : muted(isDark),
            marginRight: 6,
          }}
        />
        <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted(isDark), textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {isError ? 'Error' : 'Output'}
        </Text>
      </View>
      {/* Content */}
      <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
        <MonoBlock isDark={isDark} color={isError ? (isDark ? '#f87171' : '#dc2626') : undefined} maxLines={30}>
          {displayOutput}
        </MonoBlock>
      </View>
    </View>
  );
}

// ─── Bash syntax highlighting ────────────────────────────────────────────────

// Common bash commands/builtins to highlight
const BASH_COMMANDS = new Set([
  'ls', 'cd', 'cat', 'echo', 'grep', 'find', 'mkdir', 'rm', 'cp', 'mv',
  'touch', 'chmod', 'chown', 'head', 'tail', 'sort', 'uniq', 'wc', 'diff',
  'sed', 'awk', 'curl', 'wget', 'tar', 'zip', 'unzip', 'git', 'npm', 'npx',
  'node', 'python', 'python3', 'pip', 'pip3', 'yarn', 'pnpm', 'docker',
  'which', 'export', 'source', 'eval', 'exec', 'xargs', 'tee', 'tr',
  'cut', 'paste', 'test', 'read', 'set', 'unset', 'true', 'false',
  'pwd', 'env', 'printenv', 'date', 'sleep', 'kill', 'pkill', 'ps',
  'apt', 'brew', 'make', 'cmake', 'go', 'cargo', 'rustc', 'javac', 'java',
  'ssh', 'scp', 'rsync', 'jq', 'rg', 'fd', 'bat', 'exa',
]);

// Bash operators and redirections
const BASH_OPERATORS = new Set(['&&', '||', '|', ';', '>>', '2>', '2>&1', '>&2']);

interface BashToken {
  text: string;
  type: 'prompt' | 'command' | 'flag' | 'string' | 'operator' | 'redirect' | 'path' | 'plain';
}

function tokenizeBash(command: string): BashToken[] {
  const tokens: BashToken[] = [];
  // Add prompt
  tokens.push({ text: '$ ', type: 'prompt' });

  let i = 0;
  let isFirstWord = true;
  let afterOperator = false;

  while (i < command.length) {
    // Skip whitespace
    if (command[i] === ' ' || command[i] === '\t') {
      let ws = '';
      while (i < command.length && (command[i] === ' ' || command[i] === '\t')) {
        ws += command[i];
        i++;
      }
      tokens.push({ text: ws, type: 'plain' });
      continue;
    }

    // Quoted strings
    if (command[i] === '"' || command[i] === "'") {
      const quote = command[i];
      let str = quote;
      i++;
      while (i < command.length && command[i] !== quote) {
        if (command[i] === '\\' && i + 1 < command.length) {
          str += command[i] + command[i + 1];
          i += 2;
        } else {
          str += command[i];
          i++;
        }
      }
      if (i < command.length) { str += command[i]; i++; }
      tokens.push({ text: str, type: 'string' });
      isFirstWord = false;
      afterOperator = false;
      continue;
    }

    // Multi-char operators: &&, ||, >>, 2>, 2>&1
    const rest = command.slice(i);
    let matchedOp = '';
    for (const op of ['2>&1', '>&2', '2>', '>>', '&&', '||']) {
      if (rest.startsWith(op)) { matchedOp = op; break; }
    }
    if (matchedOp) {
      tokens.push({ text: matchedOp, type: 'operator' });
      i += matchedOp.length;
      isFirstWord = true;
      afterOperator = true;
      continue;
    }

    // Single-char operators: |, ;, >, <
    if ('|;><'.includes(command[i])) {
      tokens.push({ text: command[i], type: 'operator' });
      i++;
      isFirstWord = true;
      afterOperator = true;
      continue;
    }

    // Word
    let word = '';
    while (i < command.length && !' \t|;&><"\''.includes(command[i])) {
      word += command[i];
      i++;
    }

    if (!word) { i++; continue; }

    // Classify word
    if (isFirstWord || afterOperator) {
      // Command position
      if (BASH_COMMANDS.has(word)) {
        tokens.push({ text: word, type: 'command' });
      } else {
        tokens.push({ text: word, type: 'command' });
      }
      isFirstWord = false;
      afterOperator = false;
    } else if (word.startsWith('-')) {
      tokens.push({ text: word, type: 'flag' });
    } else if (word.startsWith('/') || word.includes('/') || word.startsWith('~')) {
      tokens.push({ text: word, type: 'path' });
    } else {
      tokens.push({ text: word, type: 'plain' });
    }
  }

  return tokens;
}

function HighlightedBashCommand({ command, isDark }: { command: string; isDark: boolean }) {
  const tokens = useMemo(() => tokenizeBash(command), [command]);

  const colors: Record<BashToken['type'], string> = {
    prompt: isDark ? '#71717a' : '#a1a1aa',
    command: isDark ? '#c4b5fd' : '#7c3aed', // purple
    flag: isDark ? '#93c5fd' : '#2563eb',     // blue
    string: isDark ? '#86efac' : '#16a34a',   // green
    operator: isDark ? '#fca5a5' : '#dc2626', // red
    redirect: isDark ? '#fca5a5' : '#dc2626', // red
    path: isDark ? '#e2e8f0' : '#334155',     // slate (near-white/dark)
    plain: fg(isDark),
  };

  const fs = 11;
  const lh = 17;

  return (
    <Text style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh }}>
      {tokens.map((token, i) => (
        <Text key={i} style={{ color: colors[token.type], fontSize: fs, fontFamily: monoFont, lineHeight: lh }}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

// ─── Lightweight code syntax highlighting ────────────────────────────────────

type CodeTokenType = 'keyword' | 'string' | 'comment' | 'number' | 'heading' | 'bold' | 'bullet' | 'operator' | 'property' | 'tag' | 'attr' | 'plain';

interface CodeToken {
  text: string;
  type: CodeTokenType;
}

function getExtFromPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return '';
  return filePath.slice(dot + 1).toLowerCase();
}

const MD_HEADING_RE = /^(#{1,6}\s)/;
const MD_BOLD_RE = /\*\*[^*]+\*\*/g;
const MD_BULLET_RE = /^(\s*[-*+]|\s*\d+\.)\s/;

function tokenizeMarkdown(line: string): CodeToken[] {
  // Headings
  const headingMatch = line.match(MD_HEADING_RE);
  if (headingMatch) {
    return [{ text: line, type: 'heading' }];
  }
  // Bullets
  const bulletMatch = line.match(MD_BULLET_RE);
  if (bulletMatch) {
    const tokens: CodeToken[] = [{ text: bulletMatch[0], type: 'bullet' }];
    const rest = line.slice(bulletMatch[0].length);
    tokens.push(...tokenizeMarkdownInline(rest));
    return tokens;
  }
  return tokenizeMarkdownInline(line);
}

function tokenizeMarkdownInline(text: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let lastIdx = 0;
  const boldRe = /\*\*([^*]+)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(text)) !== null) {
    if (m.index > lastIdx) tokens.push({ text: text.slice(lastIdx, m.index), type: 'plain' });
    tokens.push({ text: m[0], type: 'bold' });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) tokens.push({ text: text.slice(lastIdx), type: 'plain' });
  if (tokens.length === 0) tokens.push({ text, type: 'plain' });
  return tokens;
}

// Generic code tokenizer for JS/TS/Python/JSON/etc
const CODE_KEYWORDS = new Set([
  'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return',
  'if', 'else', 'for', 'while', 'class', 'extends', 'new', 'this', 'super',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'default', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof',
  'in', 'of', 'true', 'false', 'null', 'undefined', 'void',
  'def', 'elif', 'except', 'pass', 'raise', 'with', 'as', 'lambda',
  'None', 'True', 'False', 'self', 'type', 'interface', 'enum',
]);

function tokenizeCode(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  // Comment
  const commentIdx = line.indexOf('//');
  const hashIdx = line.indexOf('#');
  const commentStart = commentIdx >= 0 ? commentIdx : (hashIdx === 0 ? 0 : -1);

  const codePart = commentStart >= 0 ? line.slice(0, commentStart) : line;
  const commentPart = commentStart >= 0 ? line.slice(commentStart) : '';

  // Tokenize code part
  const re = /("[^"]*"|'[^']*'|`[^`]*`|\b\d+\.?\d*\b|\b[a-zA-Z_]\w*\b|[{}()[\]:;,=<>!+\-*/&|?.]+|\s+)/g;
  let m: RegExpExecArray | null;
  let lastIdx = 0;
  while ((m = re.exec(codePart)) !== null) {
    if (m.index > lastIdx) tokens.push({ text: codePart.slice(lastIdx, m.index), type: 'plain' });
    const word = m[0];
    if (/^["'`]/.test(word)) {
      tokens.push({ text: word, type: 'string' });
    } else if (/^\d/.test(word)) {
      tokens.push({ text: word, type: 'number' });
    } else if (CODE_KEYWORDS.has(word)) {
      tokens.push({ text: word, type: 'keyword' });
    } else if (/^[{}()[\]:;,=<>!+\-*/&|?.]+$/.test(word)) {
      tokens.push({ text: word, type: 'operator' });
    } else if (/^\s+$/.test(word)) {
      tokens.push({ text: word, type: 'plain' });
    } else {
      tokens.push({ text: word, type: 'plain' });
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < codePart.length) tokens.push({ text: codePart.slice(lastIdx), type: 'plain' });

  if (commentPart) tokens.push({ text: commentPart, type: 'comment' });
  if (tokens.length === 0) tokens.push({ text: line, type: 'plain' });
  return tokens;
}

function tokenizeLine(line: string, ext: string): CodeToken[] {
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return tokenizeMarkdown(line);
  if (['json', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'swift', 'kt'].includes(ext)) {
    return tokenizeCode(line);
  }
  // Default: try code tokenizer
  return tokenizeCode(line);
}

/**
 * Strip markdown code fences from content.
 * Tool inputs sometimes wrap code in ```lang ... ``` which should not be rendered literally.
 * Strips opening fence (first line if it matches ```lang) and closing fence (last non-empty line if ```).
 * Also filters out any stray ``` lines that are purely fence markers.
 */
function stripCodeFences(text: string): string {
  // Normalize line endings
  let t = text.replace(/\r\n?/g, '\n');

  // Strip opening fence: ```lang, ```lang filename, or just ``` (anything after ```)
  t = t.replace(/^\s*```[^\n]*\n/, '');

  // Strip closing fence: ``` at end (with optional trailing whitespace/newlines)
  t = t.replace(/\n\s*```\s*\n?\s*$/, '');

  // Also strip if closing ``` is the very last line with no preceding newline (edge)
  t = t.replace(/\s*```\s*$/, '');

  return t;
}

function HighlightedCode({
  content,
  filePath,
  isDark,
  maxLines = 25,
}: {
  content: string;
  filePath: string;
  isDark: boolean;
  maxLines?: number;
}) {
  const ext = getExtFromPath(filePath);

  const colors: Record<CodeTokenType, string> = {
    keyword: isDark ? '#c4b5fd' : '#7c3aed',     // purple
    string: isDark ? '#86efac' : '#16a34a',       // green
    comment: isDark ? '#6b7280' : '#9ca3af',      // gray
    number: isDark ? '#fdba74' : '#ea580c',       // orange
    heading: isDark ? '#93c5fd' : '#2563eb',      // blue
    bold: isDark ? '#e2e8f0' : '#1e293b',         // strong fg
    bullet: isDark ? '#fdba74' : '#ea580c',       // orange
    operator: isDark ? '#a1a1aa' : '#71717a',     // muted
    property: isDark ? '#93c5fd' : '#2563eb',     // blue
    tag: isDark ? '#fca5a5' : '#dc2626',          // red
    attr: isDark ? '#fdba74' : '#ea580c',         // orange
    plain: mutedStrong(isDark),
  };

  const cleaned = stripCodeFences(content);
  const lines = cleaned.split('\n').slice(0, maxLines);
  const truncated = cleaned.split('\n').length > maxLines;
  const fs = 10;
  const lh = 15;

  return (
    <View>
      {lines.map((line, lineIdx) => {
        const tokens = tokenizeLine(line, ext);
        return (
          <Text key={lineIdx} style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh }}>
            {tokens.map((token, i) => (
              <Text
                key={i}
                style={{
                  color: colors[token.type],
                  fontSize: fs,
                  fontFamily: monoFont,
                  lineHeight: lh,
                  fontWeight: token.type === 'heading' || token.type === 'bold' ? '600' : undefined,
                }}
              >
                {token.text}
              </Text>
            ))}
          </Text>
        );
      })}
      {truncated && (
        <Text style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh, color: muted(isDark) }}>
          ...
        </Text>
      )}
    </View>
  );
}

// ─── Tool-specific expanded content renderers ────────────────────────────────

function ShellExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);
  const metadata = (tool.state as any)?.metadata || {};
  const command = input.command || metadata.command || '';
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      // Strip bash_metadata XML tags if present
      let raw = tool.state.output;
      raw = raw.replace(/<bash_metadata>[\s\S]*?<\/bash_metadata>/g, '');
      return stripAnsi(raw).trim();
    }
    if (tool.state.status === 'error' && 'error' in tool.state) {
      return tool.state.error;
    }
    return undefined;
  }, [tool.state]);

  return (
    <View>
      {/* Command */}
      {!!command && (
        <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
          <HighlightedBashCommand command={command} isDark={isDark} />
        </View>
      )}
      {/* Output */}
      {!!output && (
        <OutputSection output={output} isDark={isDark} isError={tool.state.status === 'error'} />
      )}
    </View>
  );
}

// LCS-based diff utilities — shared with ViewChangesSheet
import { generateLineDiff, getDiffStats, type DiffLine } from '@/lib/opencode/diff-utils';

/** Syntax-highlighted diff line with inline +/- prefix */
function DiffCodeLine({ text, lineType, ext, isDark, fs, lh }: {
  text: string;
  lineType: DiffLine['type'];
  ext: string;
  isDark: boolean;
  fs: number;
  lh: number;
}) {
  const tokens = useMemo(() => tokenizeLine(text, ext), [text, ext]);

  const getColor = (tokenType: CodeTokenType): string => {
    const syntaxMap: Record<CodeTokenType, string> = {
      keyword: isDark ? '#c4b5fd' : '#7c3aed',
      string: isDark ? '#86efac' : '#16a34a',
      comment: isDark ? '#6b7280' : '#9ca3af',
      number: isDark ? '#fdba74' : '#ea580c',
      heading: isDark ? '#93c5fd' : '#2563eb',
      bold: isDark ? '#e2e8f0' : '#1e293b',
      bullet: isDark ? '#fdba74' : '#ea580c',
      operator: isDark ? '#a1a1aa' : '#71717a',
      property: isDark ? '#93c5fd' : '#2563eb',
      tag: isDark ? '#fca5a5' : '#dc2626',
      attr: isDark ? '#fdba74' : '#ea580c',
      plain: isDark ? '#e4e4e7' : '#27272a',
    };
    const base = syntaxMap[tokenType];
    if (lineType === 'unchanged') {
      const r = parseInt(base.slice(1, 3), 16);
      const g = parseInt(base.slice(3, 5), 16);
      const b = parseInt(base.slice(5, 7), 16);
      return `rgba(${r},${g},${b},0.45)`;
    }
    return base;
  };

  const prefixChar = lineType === 'removed' ? '− ' : lineType === 'added' ? '+ ' : '  ';
  const prefixColor = lineType === 'removed'
    ? (isDark ? '#f87171' : '#dc2626')
    : lineType === 'added'
    ? (isDark ? '#4ade80' : '#16a34a')
    : 'transparent';

  return (
    <Text style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh, paddingVertical: 1, paddingHorizontal: 8 }}>
      <Text style={{ color: prefixColor, fontSize: fs, fontFamily: monoFont, fontWeight: '600' }}>{prefixChar}</Text>
      {tokens.map((token, i) => (
        <Text key={i} style={{ color: getColor(token.type), fontSize: fs, fontFamily: monoFont }}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

function WriteEditExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);
  const content = input.content || input.newString || '';
  const filePath = input.filePath || '';
  const ext = getExtFromPath(filePath);

  // For edit, show unified diff
  const oldString = input.oldString;
  const newString = input.newString;
  const isEdit = tool.tool === 'edit' || tool.tool === 'morph_edit';

  const lineDiff = useMemo(() => {
    if (isEdit && oldString && newString) {
      return generateLineDiff(oldString, newString);
    }
    return null;
  }, [isEdit, oldString, newString]);

  const fs = 10.5;
  const lh = 16;

  return (
    <View>
      {lineDiff ? (
        <ScrollView
          style={{ maxHeight: 300 }}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <View style={{ paddingVertical: 4 }}>
            {lineDiff.slice(0, 40).map((line, i) => {
              const isRemoved = line.type === 'removed';
              const isAdded = line.type === 'added';

              return (
                <View
                  key={i}
                  style={{
                    backgroundColor: isRemoved
                      ? (isDark ? 'rgba(239,68,68,0.06)' : 'rgba(239,68,68,0.05)')
                      : isAdded
                      ? (isDark ? 'rgba(34,197,94,0.06)' : 'rgba(34,197,94,0.05)')
                      : 'transparent',
                  }}
                >
                  <DiffCodeLine text={line.text} lineType={line.type} ext={ext} isDark={isDark} fs={fs} lh={lh} />
                </View>
              );
            })}
          </View>
          {lineDiff.length > 40 && (
            <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ fontSize: 10, fontFamily: monoFont, color: muted(isDark) }}>
                ... {lineDiff.length - 40} more lines
              </Text>
            </View>
          )}
        </ScrollView>
      ) : content ? (
        <ScrollView
          style={{ maxHeight: 250 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <HighlightedCode
            content={(() => {
              const cleaned = stripCodeFences(content);
              return cleaned.length > 3000 ? cleaned.slice(0, 3000) : cleaned;
            })()}
            filePath={filePath}
            isDark={isDark}
            maxLines={40}
          />
        </ScrollView>
      ) : null}
    </View>
  );
}

function TodosExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const todos = useMemo(() => {
    // Try parsing input.todos (check both state.input and top-level input)
    const input = getToolInput(tool);
    const raw = input.todos;
    if (Array.isArray(raw)) return raw;
    // Try parsing output
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      try {
        const parsed = JSON.parse(tool.state.output);
        if (Array.isArray(parsed)) return parsed;
        if (parsed?.todos && Array.isArray(parsed.todos)) return parsed.todos;
      } catch {}
    }
    return [];
  }, [tool.input, tool.state]);

  if (todos.length === 0) return null;

  const statusIcons: Record<string, { icon: string; color: string }> = {
    completed: { icon: 'checkmark-circle', color: isDark ? '#4ade80' : '#16a34a' },
    in_progress: { icon: 'ellipsis-horizontal-circle', color: isDark ? '#60a5fa' : '#2563eb' },
    pending: { icon: 'ellipse-outline', color: muted(isDark) },
    cancelled: { icon: 'close-circle-outline', color: muted(isDark) },
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
      {todos.map((todo: any, i: number) => {
        const st = statusIcons[todo.status] || statusIcons.pending;
        return (
          <View
            key={i}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              paddingVertical: 5,
              borderBottomWidth: i < todos.length - 1 ? 1 : 0,
              borderBottomColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
            }}
          >
            <Ionicons
              name={st.icon as any}
              size={16}
              color={st.color}
              style={{ marginRight: 8, marginTop: 1 }}
            />
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert',
                  lineHeight: 18,
                  color: todo.status === 'cancelled' ? muted(isDark) : fg(isDark),
                  textDecorationLine: todo.status === 'cancelled' ? 'line-through' : 'none',
                }}
              >
                {todo.content}
              </Text>
              {todo.priority && (
                <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted(isDark), marginTop: 1 }}>
                  {todo.priority}
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function ReadExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);
  const filePath = input.filePath || '';

  const { content, lineNumbers } = useMemo(() => {
    if (tool.state.status !== 'completed' || !('output' in tool.state) || !tool.state.output) {
      return { content: '', lineNumbers: false };
    }
    const raw = tool.state.output.trim();

    // Try to extract content from <content>...</content> XML tags
    const contentMatch = raw.match(/<content>([\s\S]*?)<\/content>/);
    if (contentMatch) {
      const extracted = contentMatch[1];
      // Content often has line numbers like "1: line text\n2: line text"
      const lines = extracted.split('\n');
      const hasLineNumbers = lines.length > 1 && lines.slice(0, 3).every(l => /^\d+:\s/.test(l));
      if (hasLineNumbers) {
        // Strip line number prefixes for clean display
        const cleanLines = lines.map(l => l.replace(/^\d+:\s/, ''));
        return { content: cleanLines.join('\n'), lineNumbers: true };
      }
      return { content: extracted, lineNumbers: false };
    }

    // Fallback: if no XML, use raw output but strip common XML wrappers
    const stripped = raw
      .replace(/<path>[\s\S]*?<\/path>/g, '')
      .replace(/<type>[\s\S]*?<\/type>/g, '')
      .replace(/<content>|<\/content>/g, '')
      .trim();

    return { content: stripped || raw, lineNumbers: false };
  }, [tool.state]);

  if (!content) return null;

  return (
    <ScrollView
      style={{ maxHeight: 300 }}
      contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      <HighlightedCode
        content={content.length > 4000 ? content.slice(0, 4000) : content}
        filePath={filePath || 'file.txt'}
        isDark={isDark}
        maxLines={50}
      />
    </ScrollView>
  );
}

function getFaviconUrl(url: string): string {
  try {
    const domain = url.replace(/^https?:\/\//, '').split('/')[0];
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch {
    return '';
  }
}

// ─── Web Search output parser (matches web frontend) ─────────────────────────

interface WebSearchSource {
  title: string;
  url: string;
  snippet?: string;
  author?: string;
}

interface WebSearchQueryResult {
  query: string;
  answer?: string;
  sources: WebSearchSource[];
}

function parseWebSearchOutput(output: string | undefined): WebSearchQueryResult[] {
  if (!output) return [];

  let parsed: any = null;
  try {
    let result = JSON.parse(output);
    // Handle double-encoded JSON
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch {}
    }
    parsed = typeof result === 'object' ? result : null;
  } catch {
    // Try trimming whitespace/BOM
    const trimmed = output.trim().replace(/^\uFEFF/, '');
    if (trimmed !== output) {
      try { parsed = JSON.parse(trimmed); } catch {}
    }
  }

  if (parsed) {
    // Batch mode: { results: [{ query, answer, results: [...] }] }
    if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
      const firstItem = parsed.results[0];
      if (firstItem && typeof firstItem.query === 'string') {
        const queryResults: WebSearchQueryResult[] = [];
        for (const r of parsed.results) {
          if (typeof r.query !== 'string') continue;
          const sources: WebSearchSource[] = [];
          if (Array.isArray(r.results)) {
            for (const s of r.results) {
              if (s.title && s.url) {
                sources.push({
                  title: s.title, url: s.url,
                  snippet: s.snippet || s.content || s.text || undefined,
                  author: s.author || undefined,
                });
              }
            }
          }
          queryResults.push({ query: r.query, answer: r.answer || undefined, sources });
        }
        if (queryResults.length > 0) return queryResults;
      } else if (firstItem && (firstItem.title || firstItem.url)) {
        // Direct results array: { results: [{title, url, content}] }
        const sources: WebSearchSource[] = [];
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title, url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
              author: s.author || undefined,
            });
          }
        }
        if (sources.length > 0) return [{ query: parsed.query || '', answer: parsed.answer || undefined, sources }];
      }
    }
    // Single result: { query, answer, results: [...] }
    if (parsed.query && typeof parsed.query === 'string') {
      const sources: WebSearchSource[] = [];
      if (Array.isArray(parsed.results)) {
        for (const s of parsed.results) {
          if (s.title && s.url) {
            sources.push({
              title: s.title, url: s.url,
              snippet: s.snippet || s.content || s.text || undefined,
              author: s.author || undefined,
            });
          }
        }
      }
      return [{ query: parsed.query, answer: parsed.answer || undefined, sources }];
    }
    // Flat array: [{title, url}, ...]
    if (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].title || parsed[0].url)) {
      const sources: WebSearchSource[] = [];
      for (const s of parsed) {
        if (s.title && s.url) {
          sources.push({
            title: s.title, url: s.url,
            snippet: s.snippet || s.content || s.text || undefined,
            author: s.author || undefined,
          });
        }
      }
      if (sources.length > 0) return [{ query: '', sources }];
    }
  }

  // Plain text fallback: Title: ...\nURL: ...
  if (typeof output === 'string') {
    const blocks = output.split(/(?=^Title: )/m).filter(Boolean);
    const sources: WebSearchSource[] = [];
    for (const block of blocks) {
      const titleMatch = block.match(/^Title:\s*(.+)/m);
      const urlMatch = block.match(/^URL:\s*(.+)/m);
      const textMatch = block.match(/^Text:\s*([\s\S]*?)$/m);
      if (titleMatch && urlMatch) {
        sources.push({
          title: titleMatch[1].trim(), url: urlMatch[1].trim(),
          snippet: textMatch?.[1]?.trim() || undefined,
        });
      }
    }
    if (sources.length > 0) return [{ query: '', sources }];
  }
  return [];
}

// ─── Web Search source row ───────────────────────────────────────────────────

function WebSearchSourceRow({ source, isDark }: { source: WebSearchSource; isDark: boolean }) {
  const domain = source.url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const faviconUri = getFaviconUrl(source.url);

  return (
    <View style={{ flexDirection: 'row', paddingVertical: 7 }}>
      {/* Favicon */}
      <View style={{
        width: 20, height: 20, borderRadius: 4,
        backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        alignItems: 'center', justifyContent: 'center',
        marginRight: 10, marginTop: 1,
      }}>
        <Image source={{ uri: faviconUri }} style={{ width: 14, height: 14, borderRadius: 2 }} />
      </View>
      {/* Content */}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: fg(isDark) }}>
          {source.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 9, fontFamily: monoFont, color: muted(isDark) }}>
            {domain}
          </Text>
          {source.author && (
            <Text numberOfLines={1} style={{ fontSize: 9, fontFamily: 'Roobert', color: muted(isDark), marginLeft: 6 }}>
              {source.author}
            </Text>
          )}
        </View>
        {source.snippet && (
          <Text numberOfLines={2} style={{ fontSize: 10, fontFamily: 'Roobert', color: mutedStrong(isDark), lineHeight: 15, marginTop: 2 }}>
            {source.snippet.slice(0, 200)}
          </Text>
        )}
      </View>
    </View>
  );
}

// ─── Web Search expanded content ─────────────────────────────────────────────

function WebSearchExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const rawOutput = tool.state.status === 'completed' && 'output' in tool.state ? tool.state.output : undefined;
  const queryResults = useMemo(() => parseWebSearchOutput(rawOutput), [rawOutput]);
  const [expandedQuery, setExpandedQuery] = useState<number | null>(null);

  const isMulti = queryResults.length > 1;

  if (queryResults.length === 0) {
    if (rawOutput?.trim()) {
      return (
        <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
          <MonoBlock isDark={isDark} maxLines={20}>{rawOutput.trim()}</MonoBlock>
        </View>
      );
    }
    return null;
  }

  return (
    <ScrollView style={{ maxHeight: 400 }} nestedScrollEnabled showsVerticalScrollIndicator>
      {queryResults.map((qr, qi) => {
        const isExpanded = expandedQuery === qi;
        const showContent = !isMulti || isExpanded;

        return (
          <View
            key={qi}
            style={{
              borderTopWidth: qi > 0 ? 1 : 0,
              borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            }}
          >
            {/* Query header (batch mode only) */}
            {isMulti && (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  LayoutAnimation.configureNext({
                    duration: 200,
                    create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
                    update: { type: LayoutAnimation.Types.easeInEaseOut },
                    delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
                  });
                  setExpandedQuery(isExpanded ? null : qi);
                }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Search size={12} color={muted(isDark)} style={{ marginRight: 8 }} />
                <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: fg(isDark), flex: 1 }}>
                  {qr.query}
                </Text>
                {qr.sources.length > 0 && (
                  <View style={{
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                    width: 20, height: 20, borderRadius: 10,
                    alignItems: 'center', justifyContent: 'center', marginLeft: 6,
                  }}>
                    <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: mutedStrong(isDark), textAlign: 'center', includeFontPadding: false, lineHeight: 10 }}>
                      {qr.sources.length}
                    </Text>
                  </View>
                )}
                <ChevronRight
                  size={12}
                  color={muted(isDark)}
                  style={{ marginLeft: 4, transform: [{ rotate: isExpanded ? '90deg' : '0deg' }] }}
                />
              </TouchableOpacity>
            )}

            {/* Answer + Sources */}
            {showContent && (
              <View style={{ paddingHorizontal: 12, paddingBottom: 10 }}>
                {/* AI Answer */}
                {!!qr.answer && (
                  <View style={{ marginBottom: 8, marginTop: isMulti ? 0 : 4 }}>
                    <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 17 }}>
                      {qr.answer.slice(0, 500)}
                    </Text>
                  </View>
                )}

                {/* Sources */}
                {qr.sources.length > 0 && (
                  <View>
                    {qr.answer && (
                      <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: muted(isDark), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                        Sources
                      </Text>
                    )}
                    {qr.sources.map((src, si) => (
                      <View
                        key={si}
                        style={{
                          borderTopWidth: si > 0 ? 1 : 0,
                          borderTopColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                        }}
                      >
                        <WebSearchSourceRow source={src} isDark={isDark} />
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

function GlobGrepExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      return stripAnsi(tool.state.output).trim();
    }
    return undefined;
  }, [tool.state]);

  if (!output) return null;

  const lines = output.split('\n').filter(Boolean);
  const isPathList = lines.length > 0 && lines.slice(0, 5).every(l => l.includes('/') || l.includes('.'));

  if (isPathList) {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        {lines.slice(0, 30).map((line, i) => {
          const parts = line.split('/');
          const filename = parts[parts.length - 1] || line;
          const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
          return (
            <View
              key={i}
              style={{
                flexDirection: 'row',
                paddingVertical: 4,
                borderBottomWidth: i < Math.min(lines.length, 30) - 1 ? 1 : 0,
                borderBottomColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
              }}
            >
              <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: monoFont, color: fg(isDark) }}>
                {filename}
              </Text>
              {!!dir && (
                <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: monoFont, color: muted(isDark), marginLeft: 6, flex: 1 }}>
                  {dir}
                </Text>
              )}
            </View>
          );
        })}
        {lines.length > 30 && (
          <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted(isDark), marginTop: 6 }}>
            +{lines.length - 30} more
          </Text>
        )}
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
      <MonoBlock isDark={isDark} maxLines={30}>
        {output.length > 3000 ? output.slice(0, 3000) + '\n...' : output}
      </MonoBlock>
    </View>
  );
}

function ShowExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);
  const title = input.title || input.description || '';
  const filePath = input.path || '';
  const content = input.content || '';

  // Parse output (always, to avoid conditional hook)
  const parsedOutput = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      const raw = tool.state.output.trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed.entry?.path || parsed.path) {
          const p = parsed.entry?.path || parsed.path;
          const t = parsed.entry?.title || parsed.title || title;
          return { type: 'file' as const, path: p, title: t };
        }
        if (parsed.message) {
          return { type: 'message' as const, text: parsed.message };
        }
      } catch {}
      return { type: 'raw' as const, text: raw };
    }
    return undefined;
  }, [tool.state, title]);

  // Show image directly if the input path is an image
  if (filePath && isImagePath(filePath) && !content) {
    return <SandboxImage filePath={filePath} isDark={isDark} height={240} />;
  }

  // Show file content with syntax highlighting if available
  if (content) {
    return (
      <ScrollView
        style={{ maxHeight: 300 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10 }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <HighlightedCode
          content={content.length > 4000 ? content.slice(0, 4000) : content}
          filePath={filePath || 'file.md'}
          isDark={isDark}
          maxLines={50}
        />
      </ScrollView>
    );
  }

  if (!parsedOutput) return null;

  if (parsedOutput.type === 'file') {
    // If the output file is an image, render it inline
    if (isImagePath(parsedOutput.path)) {
      return <SandboxImage filePath={parsedOutput.path} isDark={isDark} height={240} />;
    }
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
          <Ionicons name="document-text-outline" size={14} color={muted(isDark)} style={{ marginRight: 6 }} />
          <Text numberOfLines={1} style={{ fontSize: 11, fontFamily: monoFont, color: mutedStrong(isDark), flex: 1 }}>
            {parsedOutput.path}
          </Text>
        </View>
        {parsedOutput.title && (
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg(isDark) }}>
            {parsedOutput.title}
          </Text>
        )}
      </View>
    );
  }

  if (parsedOutput.type === 'message') {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 18 }}>
          {parsedOutput.text}
        </Text>
      </View>
    );
  }

  // Raw fallback
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 200 }}>
      <MonoBlock isDark={isDark} maxLines={15}>
        {parsedOutput.text.length > 1000 ? parsedOutput.text.slice(0, 1000) + '\n...' : parsedOutput.text}
      </MonoBlock>
    </View>
  );
}

function GenericExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      return stripAnsi(tool.state.output).trim();
    }
    if (tool.state.status === 'error' && 'error' in tool.state) {
      return tool.state.error;
    }
    return undefined;
  }, [tool.state]);

  if (!output) return null;

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
      <MonoBlock isDark={isDark} color={tool.state.status === 'error' ? (isDark ? '#f87171' : '#dc2626') : undefined} maxLines={30}>
        {output.length > 3000 ? output.slice(0, 3000) + '\n...' : output}
      </MonoBlock>
    </View>
  );
}

// ─── Memory tool renderers ───────────────────────────────────────────────────

function GetMemExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      return tool.state.output.trim();
    }
    return '';
  }, [tool.state]);

  const parsed = useMemo(() => {
    if (!output) return null;

    // Try LTM format: === LTM #N [type] ===
    const ltmMatch = output.match(/===\s*LTM\s*#(\d+)\s*\[(\w+)\]\s*===/);
    if (ltmMatch) {
      const id = ltmMatch[1];
      const type = ltmMatch[2];
      const body = output.slice(ltmMatch.index! + ltmMatch[0].length);
      const caption = body.match(/Caption:\s*(.+)/)?.[1]?.trim() || '';
      const content = body.match(/Content:\s*([\s\S]*?)(?=\n(?:Session|Created|Tags):|$)/)?.[1]?.trim() || '';
      const session = body.match(/Session:\s*(\S+)/)?.[1]?.trim() || '';
      const created = body.match(/Created:\s*(.+?)(?:\s*\||\s*$)/)?.[1]?.trim() || '';
      const updated = body.match(/Updated:\s*(.+)/)?.[1]?.trim() || '';
      const tagsStr = body.match(/Tags:\s*(.+)/)?.[1]?.trim() || '';
      const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
      return { kind: 'ltm' as const, id, type, caption, content, session, created, updated, tags };
    }

    // Try Observation format: === Observation #N [type] ===
    const obsMatch = output.match(/===\s*Observation\s*#(\d+)\s*\[(\w+)\]\s*===/);
    if (obsMatch) {
      const id = obsMatch[1];
      const type = obsMatch[2];
      const body = output.slice(obsMatch.index! + obsMatch[0].length);
      const title = body.match(/Title:\s*(.+)/)?.[1]?.trim() || '';
      const narrative = body.match(/Narrative:\s*([\s\S]*?)(?=\n(?:Facts|Concepts|Tool|Session|Created):|$)/)?.[1]?.trim() || '';
      const factsStr = body.match(/Facts:\s*([\s\S]*?)(?=\n(?:Concepts|Tool|Session|Created):|$)/)?.[1]?.trim() || '';
      const facts = factsStr ? factsStr.split('\n').map(f => f.replace(/^[-•*]\s*/, '').trim()).filter(Boolean) : [];
      const conceptsStr = body.match(/Concepts:\s*(.+)/)?.[1]?.trim() || '';
      const concepts = conceptsStr ? conceptsStr.split(',').map(c => c.trim()).filter(Boolean) : [];
      return { kind: 'observation' as const, id, type, title, narrative, facts, concepts };
    }

    return null;
  }, [output]);

  if (!parsed && !output) return null;

  const tagColor = isDark ? { bg: 'rgba(16,185,129,0.12)', text: '#34d399', border: 'rgba(16,185,129,0.2)' }
                          : { bg: 'rgba(16,185,129,0.08)', text: '#059669', border: 'rgba(16,185,129,0.2)' };
  const headerBg = isDark ? 'rgba(245,158,11,0.06)' : 'rgba(245,158,11,0.04)';
  const badgeBg = isDark ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.08)';
  const badgeText = isDark ? '#fbbf24' : '#b45309';
  const sectionBorder = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  if (!parsed) {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
        <MonoBlock isDark={isDark} maxLines={30}>{output.slice(0, 3000)}</MonoBlock>
      </View>
    );
  }

  return (
    <ScrollView style={{ maxHeight: 350 }} nestedScrollEnabled showsVerticalScrollIndicator contentContainerStyle={{ padding: 10 }}>
      {/* Header */}
      <View style={{ backgroundColor: headerBg, borderRadius: 10, padding: 10, marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <View style={{ backgroundColor: badgeBg, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1 }}>
            <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: badgeText }}>
              {parsed.kind === 'ltm' ? `LTM #${parsed.id}` : `Observation #${parsed.id}`}
            </Text>
          </View>
          <View style={{ backgroundColor: badgeBg, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1 }}>
            <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: badgeText, textTransform: 'uppercase' }}>
              {parsed.type}
            </Text>
          </View>
        </View>
        {parsed.kind === 'observation' && parsed.title && (
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-SemiBold', color: fg(isDark), marginTop: 6 }}>
            {parsed.title}
          </Text>
        )}
      </View>

      {/* Content sections */}
      {parsed.kind === 'ltm' && (
        <>
          {!!parsed.caption && (
            <View style={{ borderRadius: 8, borderWidth: 1, borderColor: sectionBorder, padding: 10, marginBottom: 6 }}>
              <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: muted(isDark), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Caption</Text>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 17 }}>{parsed.caption}</Text>
            </View>
          )}
          {!!parsed.content && (
            <View style={{ borderRadius: 8, borderWidth: 1, borderColor: sectionBorder, padding: 10, marginBottom: 6 }}>
              <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: muted(isDark), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Content</Text>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 17 }}>{parsed.content}</Text>
            </View>
          )}
          {parsed.tags.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {parsed.tags.map((tag, i) => (
                <View key={i} style={{ backgroundColor: tagColor.bg, borderRadius: 10, borderWidth: 1, borderColor: tagColor.border, paddingHorizontal: 6, paddingVertical: 1 }}>
                  <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: tagColor.text }}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
          {(parsed.session || parsed.created) && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
              {!!parsed.session && <Text style={{ fontSize: 9, fontFamily: monoFont, color: muted(isDark) }}>{parsed.session}</Text>}
              {!!parsed.created && <Text style={{ fontSize: 9, fontFamily: 'Roobert', color: muted(isDark) }}>{parsed.created}</Text>}
            </View>
          )}
        </>
      )}

      {parsed.kind === 'observation' && (
        <>
          {!!parsed.narrative && (
            <View style={{ borderRadius: 8, borderWidth: 1, borderColor: sectionBorder, padding: 10, marginBottom: 6 }}>
              <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: muted(isDark), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Narrative</Text>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 17 }}>{parsed.narrative}</Text>
            </View>
          )}
          {parsed.facts.length > 0 && (
            <View style={{ borderRadius: 8, borderWidth: 1, borderColor: sectionBorder, padding: 10, marginBottom: 6 }}>
              <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: muted(isDark), textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Facts</Text>
              {parsed.facts.map((fact, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 3 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: isDark ? '#34d399' : '#059669', marginTop: 5, marginRight: 6 }} />
                  <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 17, flex: 1 }}>{fact}</Text>
                </View>
              ))}
            </View>
          )}
          {parsed.concepts.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {parsed.concepts.map((concept, i) => (
                <View key={i} style={{ backgroundColor: tagColor.bg, borderRadius: 10, borderWidth: 1, borderColor: tagColor.border, paddingHorizontal: 6, paddingVertical: 1 }}>
                  <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: tagColor.text }}>{concept}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function LtmSearchExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      return tool.state.output.trim();
    }
    return '';
  }, [tool.state]);

  const { label, hits } = useMemo(() => {
    if (!output) return { label: '', hits: [] as any[] };

    // Parse header: === LTM Search: "query" (N results) ===
    const headerMatch = output.match(/===\s*(.+?)\s*===/);
    const label = headerMatch?.[1] || '';

    // Parse detailed blocks: #N [type] — content
    const blockRe = /#(\d+)\s*\[(\w+)\]\s*[—–-]\s*([\s\S]*?)(?=\n\s*#\d+\s*\[|$)/g;
    const hits: { id: string; type: string; content: string; confidence?: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(output)) !== null) {
      const content = m[3].trim().replace(/^\s*Files:.*$/m, '').trim();
      hits.push({ id: m[1], type: m[2], content });
    }

    return { label, hits };
  }, [output]);

  if (!output) return null;

  if (hits.length === 0) {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
        <MonoBlock isDark={isDark} maxLines={30}>{output.slice(0, 3000)}</MonoBlock>
      </View>
    );
  }

  const sectionBorder = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  return (
    <ScrollView style={{ maxHeight: 350 }} nestedScrollEnabled showsVerticalScrollIndicator contentContainerStyle={{ padding: 10 }}>
      {hits.map((hit, i) => (
        <View
          key={i}
          style={{
            borderRadius: 8, borderWidth: 1, borderColor: sectionBorder,
            padding: 10, marginBottom: 6, backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <View style={{
              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1,
            }}>
              <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: mutedStrong(isDark) }}>
                {hit.type}
              </Text>
            </View>
            <Text style={{ fontSize: 9, fontFamily: monoFont, color: muted(isDark) }}>
              #{hit.id}
            </Text>
          </View>
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: fg(isDark), lineHeight: 17 }}>
            {hit.content}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function QuestionExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const input = getToolInput(tool);

  // Parse questions and answers from input or output
  const qaPairs = useMemo(() => {
    const pairs: { question: string; answer: string }[] = [];

    // First, try to get answers from output
    const outputAnswers = new Map<string, string>();
    const raw = (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output)
      ? tool.state.output.trim() : '';

    if (raw) {
      // Try "question"="answer" format
      const pairMatches = [...raw.matchAll(/"([^"]+?)"\s*=\s*"([^"]*?)"/g)];
      for (const m of pairMatches) {
        outputAnswers.set(m[1], m[2]);
      }

      // Try JSON format
      if (outputAnswers.size === 0) {
        try {
          const parsed = JSON.parse(raw);
          const arr = Array.isArray(parsed) ? parsed : parsed?.questions;
          if (Array.isArray(arr)) {
            for (const item of arr) {
              if (item.question && item.answer) {
                outputAnswers.set(item.question, item.answer);
              }
            }
          }
        } catch {}
      }
    }

    // Get questions from input and merge with answers from output
    const questions = input.questions;
    if (Array.isArray(questions)) {
      for (const q of questions) {
        const qText = typeof q === 'object' ? q.question : typeof q === 'string' ? q : '';
        const inputAnswer = typeof q === 'object' ? q.answer || '' : '';
        const outputAnswer = outputAnswers.get(qText) || '';
        pairs.push({ question: qText, answer: inputAnswer || outputAnswer });
      }
      // Also add any output pairs not found in input
      for (const [question, answer] of outputAnswers) {
        if (!pairs.some(p => p.question === question)) {
          pairs.push({ question, answer });
        }
      }
      if (pairs.length > 0) return pairs;
    }

    // No input questions — use output pairs directly
    if (outputAnswers.size > 0) {
      for (const [question, answer] of outputAnswers) {
        pairs.push({ question, answer });
      }
      return pairs;
    }

    // Fallback: show raw output
    if (raw) return [{ question: '', answer: raw }];

    return pairs;
  }, [input, tool.state]);

  const answeredCount = qaPairs.filter(q => q.answer).length;

  if (qaPairs.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
      {qaPairs.map((qa, i) => (
        <View
          key={i}
          style={{
            paddingVertical: 6,
            borderBottomWidth: i < qaPairs.length - 1 ? 1 : 0,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
          }}
        >
          {!!qa.question && (
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedStrong(isDark), lineHeight: 18 }}>
              {qa.question}
            </Text>
          )}
          {!!qa.answer && (
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg(isDark), lineHeight: 18, marginTop: qa.question ? 2 : 0 }}>
              {qa.answer}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

// ─── Session Get — rich display for session_get tool ────────────────────────

interface SessionGetData {
  title: string;
  id: string;
  created: string;
  updated: string;
  changes: string;
  parent: string | null;
  todos: Array<{ status: 'completed' | 'in_progress' | 'pending'; text: string }>;
  messageCount: string;
  toolCallCount: string;
  compressionNote: string | null;
  hasConversation: boolean;
}

function parseSessionGet(output: string): SessionGetData | null {
  if (!output || typeof output !== 'string') return null;
  const titleMatch = output.match(/^=== SESSION:\s*(.+?)\s*===$/m);
  if (!titleMatch) return null;

  const idMatch = output.match(/^ID:\s*(ses_\S+)/m);
  const createdMatch = output.match(/Created:\s*(\S+ \S+)/);
  const updatedMatch = output.match(/Updated:\s*(\S+ \S+)/);
  const changesMatch = output.match(/Changes:\s*(.+)/m);
  const parentMatch = output.match(/Parent:\s*(ses_\S+)/m);

  // Todos
  const todosSection = output.match(/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m);
  const todos: SessionGetData['todos'] = [];
  if (todosSection) {
    for (const line of todosSection[1].split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '(none)') continue;
      const statusMatch = trimmed.match(/^\[(\w+)\]\s*(.*)/);
      if (statusMatch) {
        const s = statusMatch[1] as string;
        const status = s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
        todos.push({ status, text: statusMatch[2] });
      } else {
        todos.push({ status: 'pending', text: trimmed });
      }
    }
  }

  // Conversation header
  const convHeader = output.match(/=== CONVERSATION \((\d+) msgs?, (\d+) tool calls?/);
  const compressionMatch = output.match(/=== COMPRESSION ===\n(.+)/m);

  return {
    title: titleMatch[1],
    id: idMatch?.[1] ?? '',
    created: createdMatch?.[1] ?? '',
    updated: updatedMatch?.[1] ?? '',
    changes: changesMatch?.[1] ?? 'no changes',
    parent: parentMatch?.[1] ?? null,
    todos,
    messageCount: convHeader?.[1] ?? '0',
    toolCallCount: convHeader?.[2] ?? '0',
    compressionNote: compressionMatch?.[1]?.trim() ?? null,
    hasConversation: !!convHeader,
  };
}

function SessionGetExpandedContent({ tool, isDark }: { tool: ToolPart; isDark: boolean }) {
  const output = useMemo(() => {
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      return stripAnsi(tool.state.output).trim();
    }
    return '';
  }, [tool.state]);

  const data = useMemo(() => parseSessionGet(output), [output]);

  if (!data) {
    // Fallback to generic
    return output ? (
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, maxHeight: 250 }}>
        <MonoBlock isDark={isDark} maxLines={30}>
          {output.length > 3000 ? output.slice(0, 3000) + '\n...' : output}
        </MonoBlock>
      </View>
    ) : null;
  }

  const metaColor = muted(isDark);
  const metaFs = 11;

  return (
    <ScrollView style={{ maxHeight: 400 }} nestedScrollEnabled showsVerticalScrollIndicator>
      <View style={{ padding: 12, gap: 10 }}>
        {/* Session title */}
        <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg(isDark), lineHeight: 20 }}>
          {data.title}
        </Text>

        {/* Metadata grid */}
        <View style={{ gap: 4 }}>
          {/* ID */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 9, fontFamily: monoFont, color: metaColor, opacity: 0.7 }}>
              {data.id}
            </Text>
          </View>

          {/* Timestamps */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
              Created {data.created}
            </Text>
            {data.updated && data.updated !== data.created && (
              <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
                Updated {data.updated}
              </Text>
            )}
          </View>

          {/* Changes + Messages */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
              {data.changes}
            </Text>
            {data.hasConversation && (
              <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
                {data.messageCount} msgs · {data.toolCallCount} tool calls
              </Text>
            )}
          </View>

          {/* Parent */}
          {data.parent && (
            <Text style={{ fontSize: metaFs, fontFamily: 'Roobert', color: metaColor }}>
              Parent: <Text style={{ fontFamily: monoFont, fontSize: 10 }}>{data.parent}</Text>
            </Text>
          )}
        </View>

        {/* Todos */}
        {data.todos.length > 0 && (
          <View
            style={{
              borderRadius: 8,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
              backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
              padding: 10,
              gap: 6,
            }}
          >
            <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: mutedStrong(isDark), textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Todos ({data.todos.length})
            </Text>
            {data.todos.map((todo, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
                <View
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    borderWidth: 1.5,
                    marginTop: 1,
                    borderColor: todo.status === 'completed'
                      ? (isDark ? '#4ade80' : '#16a34a')
                      : todo.status === 'in_progress'
                      ? (isDark ? '#60a5fa' : '#2563eb')
                      : (isDark ? '#52525b' : '#d4d4d8'),
                    backgroundColor: todo.status === 'completed'
                      ? (isDark ? 'rgba(74,222,128,0.15)' : 'rgba(22,163,74,0.1)')
                      : 'transparent',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {todo.status === 'completed' && (
                    <Text style={{ fontSize: 9, color: isDark ? '#4ade80' : '#16a34a', fontWeight: '700' }}>✓</Text>
                  )}
                  {todo.status === 'in_progress' && (
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: isDark ? '#60a5fa' : '#2563eb' }} />
                  )}
                </View>
                <Text
                  style={{
                    flex: 1,
                    fontSize: 12,
                    fontFamily: 'Roobert',
                    lineHeight: 17,
                    color: todo.status === 'completed' ? muted(isDark) : fg(isDark),
                    textDecorationLine: todo.status === 'completed' ? 'line-through' : 'none',
                  }}
                >
                  {todo.text}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Compression badge */}
        {data.compressionNote && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View
              style={{
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 4,
                backgroundColor: isDark ? 'rgba(52,211,153,0.12)' : 'rgba(5,150,105,0.08)',
              }}
            >
              <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: isDark ? '#34d399' : '#059669' }}>
                Compressed
              </Text>
            </View>
            <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted(isDark) }}>
              {data.compressionNote}
            </Text>
          </View>
        )}

        {/* No messages indicator */}
        {!data.hasConversation && (
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted(isDark), fontStyle: 'italic' }}>
            No messages in this session
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

// ─── Get expanded content by tool type ───────────────────────────────────────

function getExpandedContent(tool: ToolPart, isDark: boolean): React.ReactNode {
  switch (tool.tool) {
    case 'bash':
      return <ShellExpandedContent tool={tool} isDark={isDark} />;
    case 'write':
    case 'edit':
    case 'morph_edit':
      return <WriteEditExpandedContent tool={tool} isDark={isDark} />;
    case 'todowrite':
      return <TodosExpandedContent tool={tool} isDark={isDark} />;
    case 'read':
      return <ReadExpandedContent tool={tool} isDark={isDark} />;
    case 'websearch':
    case 'web-search':
    case 'web_search':
      return <WebSearchExpandedContent tool={tool} isDark={isDark} />;
    case 'glob':
    case 'grep':
    case 'list':
      return <GlobGrepExpandedContent tool={tool} isDark={isDark} />;
    case 'question':
      return <QuestionExpandedContent tool={tool} isDark={isDark} />;
    case 'get_mem':
    case 'get-mem':
    case 'oc-get_mem':
    case 'oc-get-mem':
      return <GetMemExpandedContent tool={tool} isDark={isDark} />;
    case 'ltm_search':
    case 'ltm-search':
    case 'mem_search':
    case 'mem-search':
    case 'memory_search':
    case 'memory-search':
    case 'oc-mem_search':
    case 'oc-mem-search':
      return <LtmSearchExpandedContent tool={tool} isDark={isDark} />;
    case 'show':
    case 'show-user':
      return <ShowExpandedContent tool={tool} isDark={isDark} />;
    case 'session_get':
    case 'session-get':
    case 'oc-session_get':
    case 'oc-session-get':
      return <SessionGetExpandedContent tool={tool} isDark={isDark} />;
    case 'webfetch':
    case 'scrape-webpage':
      return <GenericExpandedContent tool={tool} isDark={isDark} />;
    default:
      return <GenericExpandedContent tool={tool} isDark={isDark} />;
  }
}

// ─── Check if tool has expandable content ────────────────────────────────────

function toolHasExpandableContent(tool: ToolPart): boolean {
  const { state } = tool;
  const input = getToolInput(tool);
  // Running/pending tools are always expandable (to watch streaming)
  if (state.status === 'running' || state.status === 'pending') return true;
  // Todos always expandable if input has todos
  if (tool.tool === 'todowrite' && Array.isArray(input.todos) && input.todos.length > 0) return true;
  // Shell expandable if has command, description, or output
  if (tool.tool === 'bash' && (input.command || input.description)) return true;
  // Write/Edit expandable if has content
  if ((tool.tool === 'write' || tool.tool === 'edit' || tool.tool === 'morph_edit') &&
      (input.content || input.oldString || input.newString)) return true;
  // Show tool expandable if has content or path
  if ((tool.tool === 'show' || tool.tool === 'show-user') && (input.content || input.path)) return true;
  // Question tool always expandable
  if (tool.tool === 'question') return true;
  // Any tool with completed output is expandable
  if (state.status === 'completed' && 'output' in state && state.output?.trim()) return true;
  // Any tool with error is expandable
  if (state.status === 'error' && 'error' in state && state.error) return true;
  return false;
}

// ─── ShowToolCard — rich interactive card for "show" / "show-user" tool ──────

const LOCALHOST_RE = /https?:\/\/localhost:(\d+)(\/[^\s)]*)?/;

function ShowToolCard({
  tool,
  isDark,
}: {
  tool: ToolPart;
  isDark: boolean;
}) {
  const input = getToolInput(tool);
  const { sandboxId, sandboxUrl: ctxSandboxUrl } = useSandboxContext();

  const title = (input.title as string) || '';
  const description = (input.description as string) || '';
  const type = (input.type as string) || '';
  const url = (input.url as string) || '';
  const path = (input.path as string) || '';
  const content = (input.content as string) || '';
  const isRunning = tool.state.status === 'pending' || tool.state.status === 'running';
  const isError = tool.state.status === 'error';

  // Determine if we have a localhost URL to open in browser
  const localhostMatch = url ? url.match(LOCALHOST_RE) : null;
  const hasLocalhostUrl = !!localhostMatch;
  const canOpen = !!(url || path || hasLocalhostUrl);
  const isHtmlFile = !!path && /\.(html?|htm)$/i.test(path);

  // Determine display title
  const displayTitle = title || (type === 'error' ? 'Error' : type === 'url' ? 'Link' : 'Output');

  // Determine icon
  const IconComponent = (() => {
    switch (type) {
      case 'image': return ImageIcon;
      case 'code': return FileCode2;
      case 'markdown': return FileText;
      case 'html': return Globe;
      case 'url': return Globe;
      case 'error': return CircleAlert;
      case 'file': return FileText;
      default: return ExternalLink;
    }
  })();

  // Open button label
  const openLabel = isHtmlFile || hasLocalhostUrl ? 'Open Preview' : url ? 'Open Link' : 'Open File';

  // File viewer state
  const [fileViewerVisible, setFileViewerVisible] = useState(false);

  // Expandable content state
  const [expanded, setExpanded] = useState(false);
  const hasExpandableContent = !!(content || (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output?.trim()));
  const chevronRotation = useSharedValue(0);

  useEffect(() => {
    chevronRotation.value = withTiming(expanded ? 1 : 0, { duration: 200 });
  }, [expanded]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value * 180}deg` }],
  }));

  const handleOpen = useCallback(() => {
    if (!canOpen || !sandboxId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (hasLocalhostUrl && localhostMatch) {
      const port = parseInt(localhostMatch[1], 10);
      const urlPath = localhostMatch[2] || '';
      const proxyUrl = getSandboxPortUrl(sandboxId, String(port)) + urlPath;
      useTabStore.getState().navigateToPage('page:browser');
      useTabStore.getState().setTabState('page:browser', {
        savedUrl: proxyUrl,
        savedDisplay: `localhost:${port}${urlPath}`,
      });
    } else if (url) {
      // External URL — open in browser page
      useTabStore.getState().navigateToPage('page:browser');
      useTabStore.getState().setTabState('page:browser', {
        savedUrl: url,
        savedDisplay: url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      });
    } else if (path) {
      // Open file in the file viewer (supports download)
      setFileViewerVisible(true);
    }
  }, [canOpen, sandboxId, hasLocalhostUrl, localhostMatch, url, path]);

  const handleToggle = useCallback(() => {
    if (!hasExpandableContent) return;
    LayoutAnimation.configureNext({
      duration: 200,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setExpanded((prev) => !prev);
  }, [hasExpandableContent]);

  const borderColor = isError
    ? (isDark ? 'rgba(239,68,68,0.2)' : 'rgba(220,38,38,0.15)')
    : (isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)');

  return (
    <View
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderColor,
        backgroundColor: cardBg(isDark),
        marginBottom: 6,
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 14,
          paddingVertical: 12,
        }}
      >
        {/* Icon */}
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 10,
          }}
        >
          {isRunning ? (
            <SpinningLoader size={16} color={muted(isDark)} />
          ) : (
            <IconComponent size={16} color={mutedStrong(isDark)} />
          )}
        </View>

        {/* Title + Description */}
        <View style={{ flex: 1, minWidth: 0 }}>
          {isRunning ? (
            <ShimmerStatusText text="Preparing output..." size="sm" />
          ) : (
            <>
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 14,
                  fontFamily: 'Roobert-Medium',
                  color: fg(isDark),
                }}
              >
                {displayTitle}
              </Text>
              {description ? (
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 11,
                    fontFamily: 'Roobert',
                    color: muted(isDark),
                    lineHeight: 15,
                  }}
                >
                  {description}
                </Text>
              ) : null}
            </>
          )}
        </View>

        {/* Open button — for URLs, localhost, and file paths */}
        {!isRunning && canOpen && (
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleOpen}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              marginLeft: 8,
            }}
          >
            <ExternalLink size={12} color={fg(isDark)} style={{ marginRight: 4 }} />
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg(isDark) }}>
              {openLabel}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Inline image preview (like web) ── */}
      {!isRunning && type === 'image' && path && isImagePath(path) && (
        <SandboxImage filePath={path} isDark={isDark} height={260} />
      )}

      {/* ── Expand toggle for non-image content ── */}
      {hasExpandableContent && !isRunning && !(type === 'image' && path && isImagePath(path)) && (
        <>
          <TouchableOpacity
            activeOpacity={0.7}
            onPress={handleToggle}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderTopWidth: 1,
              borderTopColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
            }}
          >
            <ReAnimated.View style={chevronStyle}>
              <ChevronDown size={14} color={muted(isDark)} />
            </ReAnimated.View>
            <Text
              style={{
                marginLeft: 6,
                fontSize: 12,
                fontFamily: 'Roobert-Medium',
                color: muted(isDark),
              }}
            >
              {expanded ? 'Hide Content' : 'Show Content'}
            </Text>
          </TouchableOpacity>

          {expanded && (
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
              }}
            >
              <ShowExpandedContent tool={tool} isDark={isDark} />
            </View>
          )}
        </>
      )}

      {/* File Viewer modal */}
      {path && (
        <FileViewer
          visible={fileViewerVisible}
          onClose={() => setFileViewerVisible(false)}
          file={{ name: path.split('/').pop() || 'file', path, type: 'file' } as SandboxFile}
          sandboxId={sandboxId || ''}
          sandboxUrl={ctxSandboxUrl}
        />
      )}
    </View>
  );
}

// ─── ToolCard — expandable tool call card ────────────────────────────────────

function ToolCard({
  tool,
  isDark,
}: {
  tool: ToolPart;
  isDark: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const input = getToolInput(tool);
  const info = getToolInfo(tool.tool, input);
  const isRunning = tool.state.status === 'pending' || tool.state.status === 'running';
  const isError = tool.state.status === 'error';

  // Question tool: compute "N answered" subtitle
  const questionSubtitle = useMemo(() => {
    if (tool.tool !== 'question') return undefined;
    if (tool.state.status === 'completed' && 'output' in tool.state && tool.state.output) {
      const raw = tool.state.output.trim();
      // Count answered questions from "q"="a" pairs
      const matches = [...raw.matchAll(/"[^"]+?"\s*=\s*"[^"]*?"/g)];
      if (matches.length > 0) return `${matches.length} answered`;
      // Try JSON
      try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : parsed?.questions;
        if (Array.isArray(arr)) {
          const answered = arr.filter((q: any) => q.answer).length;
          if (answered > 0) return `${answered} answered`;
        }
      } catch {}
    }
    return undefined;
  }, [tool.tool, tool.state]);

  // Edit tool: compute diff stats for +N -N badges
  const diffStats = useMemo(() => {
    const isEditTool = tool.tool === 'edit' || tool.tool === 'morph_edit';
    if (!isEditTool) return null;
    const oldStr = input.oldString;
    const newStr = input.newString;
    if (!oldStr || !newStr) return null;
    return getDiffStats(oldStr, newStr);
  }, [tool.tool, input.oldString, input.newString]);

  const displaySubtitle = questionSubtitle || info.subtitle;

  const IconComponent = getToolLucideIcon(info.icon);
  const iconColor = mutedStrong(isDark);

  const hasExpandable = toolHasExpandableContent(tool);

  const chevronRotation = useSharedValue(0);

  const handlePress = useCallback(() => {
    if (!hasExpandable && !isRunning) return;
    LayoutAnimation.configureNext({
      duration: 200,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setExpanded((prev) => !prev);
  }, [hasExpandable, isRunning]);

  useEffect(() => {
    chevronRotation.value = withTiming(expanded ? 1 : 0, { duration: 200 });
  }, [expanded]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value * 90}deg` }],
  }));

  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: cardBorder(isDark),
        backgroundColor: cardBg(isDark),
        marginBottom: 6,
        overflow: 'hidden',
      }}
    >
      {/* Header row */}
      <TouchableOpacity
        activeOpacity={hasExpandable ? 0.7 : 1}
        onPress={handlePress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        {/* Tool icon */}
        <IconComponent size={15} color={iconColor} style={{ marginRight: 8 }} />

        {isRunning ? (
          /* Shimmer over title + subtitle while streaming */
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
            <ShimmerStatusText text={info.title + (info.subtitle ? ` ${info.subtitle}` : '')} size="sm" />
          </View>
        ) : (
          <>
            {/* Title */}
            <Text
              style={{
                fontSize: 13,
                fontFamily: 'Roobert-Medium',
                color: fg(isDark),
              }}
            >
              {info.title}
            </Text>

            {/* Subtitle */}
            {displaySubtitle && (
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  marginLeft: 6,
                  fontSize: 12,
                  fontFamily: questionSubtitle ? 'Roobert' : monoFont,
                  color: muted(isDark),
                }}
              >
                {displaySubtitle}
              </Text>
            )}
          </>
        )}

        {/* Diff stats badges (+N -N) for edit tools */}
        {diffStats && !isRunning && (diffStats.additions > 0 || diffStats.deletions > 0) && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8, gap: 4 }}>
            {diffStats.additions > 0 && (
              <Text style={{ fontSize: 11, fontFamily: monoFont, color: isDark ? '#4ade80' : '#16a34a' }}>
                +{diffStats.additions}
              </Text>
            )}
            {diffStats.deletions > 0 && (
              <Text style={{ fontSize: 11, fontFamily: monoFont, color: isDark ? '#f87171' : '#dc2626' }}>
                -{diffStats.deletions}
              </Text>
            )}
          </View>
        )}

        {/* Right side: status indicator or chevron */}
        <View style={{ marginLeft: 'auto', paddingLeft: 8 }}>
          {isRunning ? (
            <SpinningLoader size={14} color={muted(isDark)} />
          ) : isError ? (
            <CircleAlert size={14} color={isDark ? '#ef4444' : '#dc2626'} />
          ) : hasExpandable ? (
            <ReAnimated.View style={chevronStyle}>
              <ChevronRight size={14} color={isDark ? '#52525b' : '#a1a1aa'} />
            </ReAnimated.View>
          ) : (
            <Check size={14} color={isDark ? '#4ade80' : '#16a34a'} />
          )}
        </View>
      </TouchableOpacity>

      {/* Expanded content — tool-specific */}
      {expanded && (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
          }}
        >
          {getExpandedContent(tool, isDark)}
        </View>
      )}
    </View>
  );
}

// ─── Spinning Loader ─────────────────────────────────────────────────────────

function SpinningLoader({ size, color }: { size: number; color: string }) {
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 1000, easing: Easing.linear }),
      -1,
      false,
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <ReAnimated.View style={animatedStyle}>
      <Loader2 size={size} color={color} />
    </ReAnimated.View>
  );
}

// ─── Mention highlighting ────────────────────────────────────────────────────

interface ParsedSessionRef {
  id: string;
  title: string;
}

function parseSessionReferences(text: string): {
  cleanText: string;
  sessions: ParsedSessionRef[];
} {
  const sessions: ParsedSessionRef[] = [];
  let cleaned = text.replace(
    /<session_ref\s+id="([^"]*?)"\s+title="([^"]*?)"\s*\/>/g,
    (_, id, title) => {
      sessions.push({ id, title });
      return '';
    },
  );
  cleaned = cleaned
    .replace(
      /\n*Referenced sessions \(use the session_context tool to fetch details when needed\):\n?/g,
      '',
    )
    .trim();
  return { cleanText: cleaned, sessions };
}

type MentionType = 'file' | 'agent' | 'session';

interface TextSegment {
  text: string;
  type?: MentionType;
  /** Session ID (for session mentions) */
  sessionId?: string;
}

const MENTION_COLORS: Record<MentionType, string> = {
  file: '#3b82f6',    // blue
  agent: '#a855f7',   // purple
  session: '#10b981', // emerald
};

function HighlightMentions({
  text,
  agentNames,
  onFileMention,
  onSessionMention,
}: {
  text: string;
  agentNames?: string[];
  onFileMention?: (path: string) => void;
  onSessionMention?: (sessionId: string) => void;
}) {
  const segments = useMemo<TextSegment[]>(() => {
    const { cleanText, sessions } = parseSessionReferences(text);
    if (!cleanText) return [{ text: '' }];

    // Detect session mentions first (titles can contain spaces)
    const detected: { start: number; end: number; type: MentionType; sessionId?: string }[] = [];
    for (const s of sessions) {
      const needle = `@${s.title}`;
      const idx = cleanText.indexOf(needle);
      if (idx !== -1) {
        detected.push({ start: idx, end: idx + needle.length, type: 'session', sessionId: s.id });
      }
    }

    // Detect agent/file @mentions
    const agentSet = new Set(agentNames || []);
    const mentionRegex = /@(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(cleanText)) !== null) {
      const mStart = match.index;
      // Skip if overlaps with a session mention
      if (detected.some((s) => mStart >= s.start && mStart < s.end)) continue;
      const name = match[1];
      detected.push({
        start: mStart,
        end: match.index + match[0].length,
        type: agentSet.has(name) ? 'agent' : 'file',
      });
    }

    if (detected.length === 0) return [{ text: cleanText }];

    detected.sort((a, b) => a.start - b.start || b.end - a.end);
    const result: TextSegment[] = [];
    let lastIndex = 0;
    for (const ref of detected) {
      if (ref.start < lastIndex) continue;
      if (ref.start > lastIndex) result.push({ text: cleanText.slice(lastIndex, ref.start) });
      result.push({ text: cleanText.slice(ref.start, ref.end), type: ref.type, sessionId: ref.sessionId });
      lastIndex = ref.end;
    }
    if (lastIndex < cleanText.length) result.push({ text: cleanText.slice(lastIndex) });
    return result;
  }, [text, agentNames]);

  if (segments.length === 1 && !segments[0].type) {
    return (
      <Text className="text-[15px] leading-[22px] text-foreground">
        {segments[0].text}
      </Text>
    );
  }

  return (
    <Text className="text-[15px] leading-[22px] text-foreground">
      {segments.map((seg, i) => {
        if (!seg.type) {
          return <Text key={i}>{seg.text}</Text>;
        }

        const isClickable =
          (seg.type === 'file' && onFileMention) ||
          (seg.type === 'session' && onSessionMention && seg.sessionId);

        return (
          <Text
            key={i}
            style={{
              color: MENTION_COLORS[seg.type],
              fontFamily: 'Roobert-Medium',
              ...(isClickable ? { textDecorationLine: 'underline' as const, textDecorationColor: `${MENTION_COLORS[seg.type]}40` } : {}),
            }}
            onPress={
              isClickable
                ? () => {
                    if (seg.type === 'file' && onFileMention) {
                      onFileMention(seg.text.replace(/^@/, ''));
                    } else if (seg.type === 'session' && onSessionMention && seg.sessionId) {
                      onSessionMention(seg.sessionId);
                    }
                  }
                : undefined
            }
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}

// ─── SessionTurn ─────────────────────────────────────────────────────────────

interface SessionTurnProps {
  turn: Turn;
  allMessages: MessageWithParts[];
  sessionStatus?: SessionStatus;
  isBusy: boolean;
  pendingQuestions?: QuestionRequest[];
  onFork?: (messageId: string) => void;
  onEditFork?: (messageId: string, editedText: string) => void;
  agentNames?: string[];
  onFileMention?: (path: string) => void;
  onSessionMention?: (sessionId: string) => void;
  commands?: Command[];
}

export function SessionTurn({
  turn,
  allMessages,
  sessionStatus,
  isBusy,
  pendingQuestions = [],
  onFork,
  onEditFork,
  agentNames,
  onFileMention,
  onSessionMention,
  commands,
}: SessionTurnProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const allParts = useMemo(() => collectTurnParts(turn), [turn]);

  const isLast = useMemo(
    () => isLastUserMessage(turn.userMessage.info.id, allMessages),
    [turn.userMessage.info.id, allMessages],
  );

  const working = useMemo(
    () => getWorkingState(sessionStatus, isLast) || (isLast && isBusy),
    [sessionStatus, isLast, isBusy],
  );

  // Split user message into attachments + text, stripping <file> XML tags
  const { userText, userFiles } = useMemo(() => {
    const { attachments, stickyParts } = splitUserParts(turn.userMessage.parts);

    // Get raw text from sticky (non-attachment) parts
    let rawText = stickyParts
      .filter(isTextPart)
      .map((p) => (p as TextPart).text)
      .join('\n');

    // Parse and strip <file> XML tags embedded in text
    const parsedFiles: Array<{ path: string; mime: string; filename: string }> = [];
    rawText = rawText.replace(
      /<file\s+path="([^"]*?)"\s+mime="([^"]*?)"\s+filename="([^"]*?)">\s*[\s\S]*?<\/file>/g,
      (_, path, mime, filename) => {
        parsedFiles.push({ path, mime, filename });
        return '';
      },
    ).trim();

    // Combine FilePart attachments + parsed XML file refs
    const allFiles = [
      ...attachments.map((a) => ({ path: a.url || '', mime: a.mime, filename: a.filename })),
      ...parsedFiles,
    ];

    return { userText: rawText, userFiles: allFiles };
  }, [turn.userMessage.parts]);

  // Detect if this user message was generated by a slash command
  const commandInfo = useMemo(
    () => detectCommandFromText(userText, commands),
    [userText, commands],
  );

  // Detect channel message (Telegram/Slack) in user message
  const channelMessageInfo = useMemo(() => {
    if (!userText) return undefined;
    // Match pattern: [Telegram · DM · message from Name] or [Slack · #channel · message from Name]
    const headerMatch = userText.match(/^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/);
    if (!headerMatch) return undefined;
    const platform = headerMatch[1] as 'Telegram' | 'Slack';
    const context = headerMatch[2].trim();
    const userName = headerMatch[3].trim();
    // Extract the actual message (between header and Chat ID/instructions)
    const afterHeader = userText.slice(headerMatch[0].length);
    const instrStart = afterHeader.search(/\n\s*(Chat ID:|── Telegram instructions|── Slack instructions)/);
    const messageText = instrStart >= 0 ? afterHeader.slice(0, instrStart).trim() : afterHeader.trim();
    return { platform, context, userName, messageText };
  }, [userText]);

  // Detect trigger_event in user message
  const triggerEventInfo = useMemo(() => {
    if (!userText) return undefined;
    const match = userText.match(/<trigger_event>\s*([\s\S]*?)\s*<\/trigger_event>/);
    if (!match) return undefined;
    try {
      const data = JSON.parse(match[1]);
      const promptText = userText.replace(/<trigger_event>[\s\S]*?<\/trigger_event>/, '').trim();
      return { data, prompt: promptText };
    } catch {
      return undefined;
    }
  }, [userText]);

  // Build interleaved parts list (text, tools, reasoning in natural order)
  // Hide question tool parts with pending questions, hide internal tools
  const visibleParts = useMemo(() => {
    const pendingCallIDs = new Set(
      pendingQuestions.filter((q) => q.tool).map((q) => q.tool!.callID),
    );
    return allParts.filter(({ part }) => {
      if (isToolPart(part)) {
        const tp = part as ToolPart;
        if (!shouldShowToolPart(tp)) return false;
        if (tp.tool === 'question' && pendingCallIDs.has(tp.callID)) return false;
        return true;
      }
      if (isTextPart(part)) return !!(part as TextPart).text?.trim();
      if (isReasoningPart(part)) return !!(part as ReasoningPart).text?.trim();
      return false;
    });
  }, [allParts, pendingQuestions]);

  // Get the final response text (last text part) for copy/actions
  const response = useMemo(() => {
    const lastText = findLastTextPart(allParts);
    return lastText?.text ?? '';
  }, [allParts]);

  const turnError = useMemo(() => getTurnError(turn), [turn]);
  const statusText = useMemo(
    () => (working ? getTurnStatus(allParts) : undefined),
    [working, allParts],
  );

  // Retry info (only for last turn)
  const retryInfo = useMemo(
    () => (isLast ? getRetryInfo(sessionStatus) : undefined),
    [sessionStatus, isLast],
  );
  const retryMessage = useMemo(
    () => (isLast ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, isLast],
  );
  const retrySecondsLeft = useMemo(() => {
    if (!retryInfo?.next) return 0;
    return Math.max(0, Math.ceil((retryInfo.next - Date.now()) / 1000));
  }, [retryInfo]);

  // Duration
  const duration = useMemo(() => {
    if (turn.assistantMessages.length === 0) return undefined;
    const firstMsg = turn.assistantMessages[0];
    const lastMsg = turn.assistantMessages[turn.assistantMessages.length - 1];
    const start = firstMsg.info.time.created;
    const end = (lastMsg.info.time as any).completed || Date.now();
    if (!start) return undefined;
    return end - start;
  }, [turn.assistantMessages]);

  // Cost & token info (only when done)
  const costInfo = useMemo(() => {
    if (working) return undefined;
    return getTurnCost(allParts);
  }, [working, allParts]);

  // Last assistant message ID (for fork)
  const lastAssistantMessageId = useMemo(() => {
    if (turn.assistantMessages.length === 0) return undefined;
    return turn.assistantMessages[turn.assistantMessages.length - 1].info.id;
  }, [turn.assistantMessages]);

  // User message ID (for fork/edit on user bubble)
  const userMessageId = turn.userMessage.info.id;

  // Edit prompt sheet ref
  const editSheetRef = useRef<BottomSheetModal>(null);

  return (
    <View className="mb-4">
      {/* User message */}
      <View className="mb-2 px-4">
        <View className="flex-row justify-end">
        {channelMessageInfo ? (
          <View
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
              paddingHorizontal: 16,
              paddingVertical: 10,
              maxWidth: '85%',
            }}
          >
            {/* Channel badge + user name */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Ionicons
                name={channelMessageInfo.platform === 'Telegram' ? 'paper-plane-outline' : 'logo-slack'}
                size={14}
                color={channelMessageInfo.platform === 'Telegram' ? '#29B6F6' : '#E91E63'}
              />
              <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: channelMessageInfo.platform === 'Telegram' ? '#29B6F6' : '#E91E63' }}>
                {channelMessageInfo.platform}
              </Text>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: isDark ? '#71717a' : '#a1a1aa' }}>·</Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: isDark ? '#F8F8F8' : '#121215' }}>
                {channelMessageInfo.userName}
              </Text>
            </View>
            {/* Message text */}
            {channelMessageInfo.messageText ? (
              <Text
                style={{
                  fontSize: 14,
                  fontFamily: 'Roobert',
                  color: isDark ? '#F8F8F8' : '#121215',
                  lineHeight: 20,
                }}
              >
                {channelMessageInfo.messageText}
              </Text>
            ) : null}
          </View>
        ) : triggerEventInfo ? (
          <View
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
              paddingHorizontal: 16,
              paddingVertical: 10,
              maxWidth: '85%',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons
                name="timer-outline"
                size={14}
                color={isDark ? '#a1a1aa' : '#71717a'}
              />
              <Text
                style={{
                  fontSize: 14,
                  fontFamily: 'Roobert-Medium',
                  color: isDark ? '#F8F8F8' : '#121215',
                }}
              >
                {triggerEventInfo.data?.trigger || 'Scheduled Task'}
              </Text>
              {triggerEventInfo.data?.data?.manual && (
                <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
                  <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: isDark ? '#a1a1aa' : '#71717a' }}>Manual</Text>
                </View>
              )}
            </View>
            {triggerEventInfo.prompt && (
              <Text
                numberOfLines={3}
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert',
                  color: isDark ? '#71717a' : '#a1a1aa',
                  marginTop: 4,
                  paddingLeft: 22,
                }}
              >
                {triggerEventInfo.prompt}
              </Text>
            )}
          </View>
        ) : commandInfo ? (
          <View
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
              paddingHorizontal: 16,
              paddingVertical: 10,
              maxWidth: '85%',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons
                name="terminal-outline"
                size={14}
                color={isDark ? '#a1a1aa' : '#71717a'}
              />
              <Text
                style={{
                  fontSize: 14,
                  fontFamily: 'Roobert-Medium',
                  color: isDark ? '#F8F8F8' : '#121215',
                }}
              >
                /{commandInfo.name}
              </Text>
            </View>
            {commandInfo.args && (
              <Text
                numberOfLines={3}
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert',
                  color: isDark ? '#71717a' : '#a1a1aa',
                  marginTop: 4,
                  paddingLeft: 22,
                }}
              >
                {commandInfo.args}
              </Text>
            )}
          </View>
        ) : (
          <View className="rounded-2xl rounded-br-md max-w-[85%] bg-card border border-border overflow-hidden">
            {/* File attachments */}
            {userFiles.length > 0 && (
              <View style={{ padding: 10, paddingBottom: userText ? 0 : 10 }}>
                {userFiles.map((file, i) => (
                  <UserFileCard key={`${file.filename}-${i}`} file={file} isDark={isDark} />
                ))}
              </View>
            )}
            {/* Text content */}
            {!!userText && (
              <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                <HighlightMentions
                  text={userText}
                  agentNames={agentNames}
                  onFileMention={onFileMention}
                  onSessionMention={onSessionMention}
                />
              </View>
            )}
          </View>
        )}
        </View>

        {/* User message actions — copy, edit, fork */}
        {!!userText && !channelMessageInfo && !triggerEventInfo && (
          <UserMessageActions
            userText={userText}
            isDark={isDark}
            isBusy={isBusy}
            onCopy={async () => {
              await Clipboard.setStringAsync(userText);
            }}
            onEdit={() => editSheetRef.current?.present()}
            onFork={() => onFork?.(userMessageId)}
          />
        )}

        {/* Edit prompt sheet */}
        <EditPromptSheet
          ref={editSheetRef}
          initialText={userText}
          isDark={isDark}
          onSave={(editedText) => {
            onEditFork?.(userMessageId, editedText);
          }}
        />
      </View>

      {/* Assistant response — interleaved text + tool calls */}
      {(turn.assistantMessages.length > 0 || working) && (
        <View className="px-4">
          {(() => {
            // Group consecutive reasoning parts into a single GroupedReasoningCard.
            // Ported from web 38e2d41 to reduce clutter on turns with many reasoning blocks.
            type RenderItem =
              | { type: 'part'; part: Part; key: string }
              | { type: 'reasoning-group'; parts: ReasoningPart[]; key: string };

            const items: RenderItem[] = [];
            let pendingReasoning: ReasoningPart[] = [];

            const flushReasoning = () => {
              if (pendingReasoning.length > 0) {
                items.push({
                  type: 'reasoning-group',
                  parts: pendingReasoning,
                  key: `reasoning-group-${(pendingReasoning[0] as any).id ?? items.length}`,
                });
                pendingReasoning = [];
              }
            };

            for (const { part } of visibleParts) {
              if (isReasoningPart(part) && (part as ReasoningPart).text?.trim()) {
                pendingReasoning.push(part as ReasoningPart);
              } else {
                flushReasoning();
                items.push({ type: 'part', part, key: part.id });
              }
            }
            flushReasoning();

            return items.map((item) => {
              if (item.type === 'reasoning-group') {
                return (
                  <GroupedReasoningCard
                    key={item.key}
                    parts={item.parts}
                    isStreaming={working}
                  />
                );
              }

              const { part } = item;

              if (isToolPart(part)) {
                const tp = part as ToolPart;
                if (tp.tool === 'show' || tp.tool === 'show-user') {
                  return <ShowToolCard key={tp.id} tool={tp} isDark={isDark} />;
                }
                return <ToolCard key={tp.id} tool={tp} isDark={isDark} />;
              }
              if (isTextPart(part)) {
                const tp = part as TextPart;
                if (!tp.text?.trim()) return null;
                const detectedUrls = detectLocalhostUrls(tp.text);
                return (
                  <View key={tp.id} className="mb-2">
                    <SelectableMarkdownText isDark={isDark}>
                      {tp.text}
                    </SelectableMarkdownText>
                    {detectedUrls.map((detected) => (
                      <SandboxPreviewCard
                        key={`preview-${detected.port}`}
                        port={detected.port}
                        path={detected.path}
                        title={`localhost:${detected.port}${detected.path}`}
                        description="Tap to open in browser"
                      />
                    ))}
                  </View>
                );
              }
              return null;
            });
          })()}

          {/* Retry banner (shown when retrying, before the working dot) */}
          {working && retryInfo && retryMessage && (
            <View
              className="rounded-lg border mb-2 px-3 py-2"
              style={{
                backgroundColor: isDark ? 'rgba(248,248,248,0.03)' : 'rgba(18,18,21,0.02)',
                borderColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.06)',
              }}
            >
              <View className="flex-row items-start">
                <View className="mt-0.5 mr-2">
                  <SpinningLoader size={14} color={isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)'} />
                </View>
                <View className="flex-1">
                  <Text className="text-xs text-muted-foreground" style={{ lineHeight: 16 }}>
                    {retryMessage}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground/60 mt-1">
                    {retrySecondsLeft > 0
                      ? `Retrying in ${retrySecondsLeft}s (#${retryInfo.attempt})`
                      : `Retrying now (#${retryInfo.attempt})`}
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* Working indicator */}
          {working && visibleParts.length === 0 && (
            <View className="flex-row items-center py-1.5">
              <View className="h-2 w-2 rounded-full bg-foreground mr-2 animate-pulse" />
              <ShimmerStatusText text={retryInfo ? 'Waiting to retry' : (statusText || 'Thinking...')} size="sm" />
            </View>
          )}

          {/* Working status when there are already parts */}
          {working && visibleParts.length > 0 && (
            <View className="flex-row items-center mt-0.5 mb-1">
              <View className="h-1.5 w-1.5 rounded-full bg-foreground mr-1.5" />
              <ShimmerStatusText text={retryInfo ? 'Waiting to retry' : (statusText || 'Working...')} size="xs" />
            </View>
          )}

          {/* Error */}
          {!!turnError && !working && (
            <View className="mt-2 rounded-lg bg-destructive/10 px-3 py-2">
              <Text className="text-sm text-destructive">{turnError}</Text>
            </View>
          )}

          {/* Duration + Actions (when done) */}
          {!working && !!response && (
            <View style={{ marginTop: turnError ? 8 : -10 }}>
              <TurnActions
                response={response}
                duration={duration}
                costInfo={costInfo}
                isDark={isDark}
                tightToResponse={!turnError}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// UserFileCard — renders a file attachment in user message bubble
// ---------------------------------------------------------------------------

const IMAGE_MIME_RE = /^image\//;

function UserFileCard({ file, isDark }: { file: { path: string; mime: string; filename: string }; isDark: boolean }) {
  const isImage = IMAGE_MIME_RE.test(file.mime);
  const { sandboxUrl: ctxSandboxUrl } = useSandboxContext();

  // For images, try to load from sandbox
  const [imageUri, setImageUri] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage || !ctxSandboxUrl || !file.path) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAuthToken();
        const res = await fetch(`${ctxSandboxUrl}/file/raw?path=${encodeURIComponent(file.path)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onloadend = () => {
          if (!cancelled && typeof reader.result === 'string') setImageUri(reader.result);
        };
        reader.readAsDataURL(blob);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [isImage, ctxSandboxUrl, file.path]);

  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: 1,
        borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
        backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
        overflow: 'hidden',
        marginBottom: 6,
      }}
    >
      {/* Image preview */}
      {isImage && imageUri && (
        <Image
          source={{ uri: imageUri }}
          style={{ width: '100%', height: 160, borderTopLeftRadius: 9, borderTopRightRadius: 9 }}
          resizeMode="cover"
        />
      )}
      {/* File info row */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, gap: 8 }}>
        <Ionicons
          name={isImage ? 'image-outline' : file.mime === 'application/pdf' ? 'document-text-outline' : 'document-outline'}
          size={16}
          color={isDark ? '#71717a' : '#a1a1aa'}
        />
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: monoFont,
            color: isDark ? '#a1a1aa' : '#71717a',
          }}
        >
          {file.filename || file.path.split('/').pop() || 'File'}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// UserMessageActions — copy, edit, fork buttons below user message
// ---------------------------------------------------------------------------

function UserMessageActions({
  userText,
  isDark,
  isBusy,
  onCopy,
  onEdit,
  onFork,
}: {
  userText: string;
  isDark: boolean;
  isBusy: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onFork: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const mutedColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)';
  const copiedColor = isDark ? '#4ade80' : '#16a34a';

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(userText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [userText]);

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 3, gap: 0 }}>
      {/* Copy */}
      <TouchableOpacity
        onPress={handleCopy}
        activeOpacity={0.6}
        hitSlop={6}
        style={{ padding: 5, borderRadius: 6 }}
      >
        <Ionicons
          name={copied ? 'checkmark' : 'copy-outline'}
          size={13}
          color={copied ? copiedColor : mutedColor}
        />
      </TouchableOpacity>

      {/* Edit (fork with edited text) */}
      {!isBusy && (
        <TouchableOpacity
          onPress={onEdit}
          activeOpacity={0.6}
          hitSlop={6}
          style={{ padding: 5, borderRadius: 6 }}
        >
          <Ionicons name="pencil-outline" size={13} color={mutedColor} />
        </TouchableOpacity>
      )}

      {/* Fork */}
      {!isBusy && (
        <TouchableOpacity
          onPress={onFork}
          activeOpacity={0.6}
          hitSlop={6}
          style={{ padding: 5, borderRadius: 6 }}
        >
          <Ionicons name="git-branch-outline" size={13} color={mutedColor} />
        </TouchableOpacity>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// EditPromptModal — edit user message text before forking
// ---------------------------------------------------------------------------

const EditPromptSheet = React.forwardRef<BottomSheetModal, {
  initialText: string;
  isDark: boolean;
  onSave: (text: string) => void;
}>(function EditPromptSheet({ initialText, isDark, onSave }, ref) {
  const [text, setText] = useState(initialText);
  const inputRef = React.useRef<TextInput>(null);

  const bg = isDark ? '#161618' : '#FFFFFF';
  const fg_ = isDark ? '#e4e4e7' : '#18181b';
  const inputBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
  const inputBorder = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  const renderBackdrop = useMemo(
    () => (props: any) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />
    ),
    [],
  );

  // Reset text when sheet opens
  const handleChange = useCallback((index: number) => {
    if (index >= 0) {
      setText(initialText);
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [initialText]);

  const handleFork = useCallback(() => {
    if (text.trim()) {
      (ref as React.RefObject<BottomSheetModal>)?.current?.dismiss();
      onSave(text.trim());
    }
  }, [text, onSave, ref]);

  return (
    <BottomSheetModal
      ref={ref}
      index={0}
      snapPoints={['70%']}
      enableDynamicSizing={false}
      enablePanDownToClose
      onChange={handleChange}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
      backgroundStyle={{
        backgroundColor: bg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={renderBackdrop}
    >
      <View style={{ flex: 1, paddingHorizontal: 20 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 14 }}>
          <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg_ }}>
            Edit prompt
          </Text>
          <TouchableOpacity
            onPress={handleFork}
            activeOpacity={0.8}
            style={{
              backgroundColor: fg_,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderRadius: 10,
            }}
          >
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: bg }}>
              Fork
            </Text>
          </TouchableOpacity>
        </View>

        {/* Text input */}
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={setText}
          multiline
          textAlignVertical="top"
          scrollEnabled
          style={{
            flex: 1,
            fontSize: 15,
            fontFamily: 'Roobert',
            color: fg_,
            backgroundColor: inputBg,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: inputBorder,
            padding: 14,
            lineHeight: 22,
            marginBottom: 20,
          }}
        />
      </View>
    </BottomSheetModal>
  );
});

// ---------------------------------------------------------------------------
// TurnActions — fade-in action bar below assistant response (copy only)
// ---------------------------------------------------------------------------

function TurnActions({
  response,
  duration,
  costInfo,
  isDark,
  tightToResponse = true,
}: {
  response: string;
  duration?: number;
  costInfo?: { cost: number; tokens: { input: number; output: number } } | undefined;
  isDark: boolean;
  tightToResponse?: boolean;
}) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      delay: 150,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(response);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [response]);

  const mutedColor = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)';
  const durationClassName = tightToResponse
    ? 'text-xs text-muted-foreground/50 mr-2 mt-0.5'
    : 'text-xs text-muted-foreground/50 mr-2';

  return (
    <Animated.View
      style={{
        opacity: fadeAnim,
        transform: [{
          translateY: fadeAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
          }),
        }],
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: tightToResponse ? -2 : 2,
        gap: 2,
      }}
    >
      {/* Duration & cost — formatDuration returns empty for sub-second, so join on bullet */}
      {(() => {
        const durationText = duration != null && duration > 0 ? formatDuration(duration) : '';
        const costText = costInfo
          ? `${formatCost(costInfo.cost)} · ${formatTokens(costInfo.tokens.input + costInfo.tokens.output)}t`
          : '';
        const combined = [durationText, costText].filter(Boolean).join(' · ');
        if (!combined) return null;
        return <Text className={durationClassName}>{combined}</Text>;
      })()}

      {/* Copy */}
      <TouchableOpacity
        onPress={handleCopy}
        activeOpacity={0.6}
        hitSlop={6}
        style={{ padding: 5, borderRadius: 6 }}
      >
        <Ionicons
          name={copied ? 'checkmark' : 'copy-outline'}
          size={14}
          color={copied ? (isDark ? '#4ade80' : '#16a34a') : mutedColor}
        />
      </TouchableOpacity>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// detectCommandFromText — detect if a user message matches a command template
// ---------------------------------------------------------------------------

function detectCommandFromText(
  rawText: string,
  commands?: Command[],
): { name: string; args?: string } | undefined {
  if (!commands || !rawText) return undefined;

  const trimmed = rawText.trim();
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  for (const cmd of commands) {
    if (!cmd.template) continue;
    const tpl = cmd.template.trim();

    // Large templates — fast exact/prefix match
    if (tpl.length > 2000) {
      const tplBody = tpl.replace(/\s*\$ARGUMENTS\s*$/, '').trimEnd();
      if (tplBody.length > 0 && trimmed === tplBody) {
        return { name: cmd.name, args: undefined };
      }
      if (tplBody.length > 0 && trimmed.startsWith(tplBody)) {
        const after = trimmed.slice(tplBody.length).trim();
        return { name: cmd.name, args: after.length > 0 && after.length < 200 ? after : undefined };
      }
      continue;
    }

    // Find first placeholder ($1, $ARGUMENTS)
    const phMatch = tpl.match(/\$(\d+|\bARGUMENTS\b)/);
    const prefix = phMatch ? tpl.slice(0, phMatch.index).trimEnd() : tpl.trimEnd();

    if (prefix.length < 20) continue;

    if (trimmed.startsWith(prefix)) {
      let args: string | undefined;
      if (phMatch) {
        const afterPrefix = trimmed.slice(prefix.length).trim();
        const lastBlock = afterPrefix.split('\n\n').pop()?.trim();
        if (lastBlock && lastBlock.length < 200) args = lastBlock;
      }
      return { name: cmd.name, args };
    }

    // Fallback — full regex match with placeholder wildcards
    const phRegex = /\$(\d+|\bARGUMENTS\b)/g;
    const placeholders: string[] = [];
    let src = '^';
    let lastIdx = 0;
    let m: RegExpExecArray | null;

    while ((m = phRegex.exec(tpl)) !== null) {
      src += escapeRe(tpl.slice(lastIdx, m.index));
      src += '([\\s\\S]*?)';
      placeholders.push(m[1]);
      lastIdx = m.index + m[0].length;
    }
    src += escapeRe(tpl.slice(lastIdx)) + '$';

    let fullMatch: RegExpMatchArray | null;
    try {
      fullMatch = trimmed.match(new RegExp(src));
    } catch {
      continue;
    }
    if (!fullMatch) continue;

    const captures = fullMatch.slice(1).map((v) => v?.trim() ?? '');
    const argsIdx = placeholders.findIndex((n) => n.toUpperCase() === 'ARGUMENTS');
    const best =
      (argsIdx >= 0 ? captures[argsIdx] : undefined) ||
      captures.find((v) => v.length > 0);
    return {
      name: cmd.name,
      args: best && best.length < 200 ? best : undefined,
    };
  }
  return undefined;
}
