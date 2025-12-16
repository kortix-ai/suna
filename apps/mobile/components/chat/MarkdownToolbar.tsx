import * as React from 'react';
import { View, Pressable, ScrollView, Modal } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  CodeSquare,
  Minus,
  Table,
  ChevronDown,
  Heading1,
  Heading2,
  Heading3,
  Type,
  Check,
} from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { TableEditorModal } from './TableEditorModal';
import { CodeBlockEditorModal } from './CodeBlockEditorModal';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Text type options for dropdown
const TEXT_TYPES = [
  { id: 'normal', label: 'Normal', prefix: '', icon: Type },
  { id: 'h1', label: 'Heading 1', prefix: '# ', icon: Heading1 },
  { id: 'h2', label: 'Heading 2', prefix: '## ', icon: Heading2 },
  { id: 'h3', label: 'Heading 3', prefix: '### ', icon: Heading3 },
] as const;

type TextType = (typeof TEXT_TYPES)[number]['id'];

interface MarkdownToolbarProps {
  onFormat: (type: MarkdownFormat, extra?: string) => void;
  isVisible: boolean;
  text?: string;
  selection?: { start: number; end: number };
}

// Active formatting detection
interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  code: boolean;
  heading: TextType;
}

/**
 * Detect active formatting at cursor position
 */
function detectActiveFormats(text: string, cursorPos: number): ActiveFormats {
  const result: ActiveFormats = {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    code: false,
    heading: 'normal',
  };

  if (!text || cursorPos < 0) return result;

  // Get the current line for heading detection
  const beforeCursor = text.substring(0, cursorPos);
  const lastNewlineIndex = beforeCursor.lastIndexOf('\n');
  const lineStart = lastNewlineIndex === -1 ? 0 : lastNewlineIndex + 1;
  const nextNewlineIndex = text.indexOf('\n', cursorPos);
  const lineEnd = nextNewlineIndex === -1 ? text.length : nextNewlineIndex;
  const currentLine = text.substring(lineStart, lineEnd);

  // Detect heading level
  if (currentLine.startsWith('### ')) {
    result.heading = 'h3';
  } else if (currentLine.startsWith('## ')) {
    result.heading = 'h2';
  } else if (currentLine.startsWith('# ')) {
    result.heading = 'h1';
  }

  // For inline formats, check if cursor is within formatting markers
  // We look for balanced pairs around the cursor

  // Helper to check if cursor is inside a format
  const isInsideFormat = (openMarker: string, closeMarker: string): boolean => {
    // Find all occurrences of markers before cursor
    let searchPos = lineStart;
    let depth = 0;
    const relativePos = cursorPos - lineStart;
    const lineText = currentLine;

    let i = 0;
    while (i < lineText.length) {
      // Check for the marker at current position
      if (lineText.substring(i, i + openMarker.length) === openMarker) {
        if (i < relativePos) {
          // Before cursor - could be opening or closing
          // Look ahead to see if there's a closing marker
          const closePos = lineText.indexOf(closeMarker, i + openMarker.length);
          if (closePos !== -1 && closePos >= relativePos) {
            // Cursor is between open and close
            return true;
          }
        }
        i += openMarker.length;
      } else {
        i++;
      }
    }
    return false;
  };

  // Simpler approach: check surrounding context
  const checkInlineFormat = (marker: string, escapeRegex: boolean = false): boolean => {
    const escapedMarker = escapeRegex ? marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : marker;
    const pattern = new RegExp(`${escapedMarker}[^${escapedMarker[0]}]+${escapedMarker}`, 'g');

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      if (cursorPos > start && cursorPos < end) {
        return true;
      }
    }
    return false;
  };

  // Check bold: **text** (not inside code)
  // Use a more robust check
  result.bold = isWithinMarkers(text, cursorPos, '**', '**');
  result.italic = isWithinMarkers(text, cursorPos, '*', '*') && !result.bold;
  result.strikethrough = isWithinMarkers(text, cursorPos, '~~', '~~');
  result.code = isWithinMarkers(text, cursorPos, '`', '`');
  result.underline = isWithinTags(text, cursorPos, '<u>', '</u>');

  return result;
}

/**
 * Check if cursor is within balanced markers
 */
function isWithinMarkers(text: string, cursorPos: number, openMarker: string, closeMarker: string): boolean {
  // Get line boundaries
  const beforeCursor = text.substring(0, cursorPos);
  const lastNewlineIndex = beforeCursor.lastIndexOf('\n');
  const lineStart = lastNewlineIndex === -1 ? 0 : lastNewlineIndex + 1;
  const nextNewlineIndex = text.indexOf('\n', cursorPos);
  const lineEnd = nextNewlineIndex === -1 ? text.length : nextNewlineIndex;
  const lineText = text.substring(lineStart, lineEnd);
  const relativeCursor = cursorPos - lineStart;

  // For bold (**), we need to handle it specially because * is also used for italic
  if (openMarker === '**') {
    // Find pairs of **
    let i = 0;
    while (i < lineText.length - 1) {
      if (lineText[i] === '*' && lineText[i + 1] === '*') {
        // Found opening **
        const openPos = i;
        i += 2;
        // Find closing **
        while (i < lineText.length - 1) {
          if (lineText[i] === '*' && lineText[i + 1] === '*') {
            const closePos = i + 2;
            // Check if cursor is inside
            if (relativeCursor > openPos + 1 && relativeCursor < closePos - 1) {
              return true;
            }
            i += 2;
            break;
          }
          i++;
        }
      } else {
        i++;
      }
    }
    return false;
  }

  // For single char markers like * or `
  if (openMarker === '*' || openMarker === '`') {
    // Skip if checking for * and we're actually in bold
    if (openMarker === '*') {
      // Check we're not in a ** pair
      let i = 0;
      while (i < lineText.length) {
        if (lineText[i] === '*') {
          if (i + 1 < lineText.length && lineText[i + 1] === '*') {
            // Skip bold markers
            i += 2;
            // Find closing **
            while (i < lineText.length - 1) {
              if (lineText[i] === '*' && lineText[i + 1] === '*') {
                i += 2;
                break;
              }
              i++;
            }
            continue;
          }
          // Single * - find matching one
          const openPos = i;
          i++;
          while (i < lineText.length) {
            if (lineText[i] === '*') {
              if (i + 1 < lineText.length && lineText[i + 1] === '*') {
                // This is part of bold, skip
                i += 2;
                continue;
              }
              const closePos = i + 1;
              if (relativeCursor > openPos && relativeCursor < closePos) {
                return true;
              }
              i++;
              break;
            }
            i++;
          }
        } else {
          i++;
        }
      }
      return false;
    }

    // For backtick
    let inMarker = false;
    let markerStart = -1;
    for (let i = 0; i < lineText.length; i++) {
      if (lineText[i] === openMarker) {
        if (!inMarker) {
          inMarker = true;
          markerStart = i;
        } else {
          // Closing marker
          if (relativeCursor > markerStart && relativeCursor <= i) {
            return true;
          }
          inMarker = false;
        }
      }
    }
    return false;
  }

  // For ~~ (strikethrough)
  if (openMarker === '~~') {
    let i = 0;
    while (i < lineText.length - 1) {
      if (lineText[i] === '~' && lineText[i + 1] === '~') {
        const openPos = i;
        i += 2;
        while (i < lineText.length - 1) {
          if (lineText[i] === '~' && lineText[i + 1] === '~') {
            const closePos = i + 2;
            if (relativeCursor > openPos + 1 && relativeCursor < closePos - 1) {
              return true;
            }
            i += 2;
            break;
          }
          i++;
        }
      } else {
        i++;
      }
    }
    return false;
  }

  return false;
}

/**
 * Check if cursor is within HTML-style tags
 */
function isWithinTags(text: string, cursorPos: number, openTag: string, closeTag: string): boolean {
  let searchStart = 0;
  while (true) {
    const openPos = text.indexOf(openTag, searchStart);
    if (openPos === -1) break;

    const closePos = text.indexOf(closeTag, openPos + openTag.length);
    if (closePos === -1) break;

    if (cursorPos > openPos + openTag.length - 1 && cursorPos < closePos + 1) {
      return true;
    }

    searchStart = closePos + closeTag.length;
  }
  return false;
}

export type MarkdownFormat =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'code'
  | 'bullet-list'
  | 'numbered-list'
  | 'checklist'
  | 'quote'
  | 'code-block'
  | 'horizontal-rule'
  | 'link'
  | 'table'
  | 'heading';

// Tool button component
interface ToolButtonProps {
  icon: React.ComponentType<any>;
  onPress: () => void;
  isActive?: boolean;
  label?: string;
}

const ToolButton = React.memo(({ icon: IconComponent, onPress, isActive = false, label }: ToolButtonProps) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      onPress={onPress}
      className={`h-9 w-9 items-center justify-center rounded-xl ${isActive ? 'bg-primary/10' : ''}`}
      style={animatedStyle}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <Icon
        as={IconComponent}
        size={18}
        className={isActive ? 'text-primary' : 'text-foreground'}
        strokeWidth={2}
      />
    </AnimatedPressable>
  );
});

ToolButton.displayName = 'ToolButton';

// Divider component
const ToolbarDivider = () => (
  <View className="mx-1.5 h-5 w-[1px] bg-border/60" />
);

// Text type dropdown component
interface TextTypeDropdownProps {
  selectedType: TextType;
  onSelect: (type: TextType) => void;
}

const TextTypeDropdown = React.memo(({ selectedType, onSelect }: TextTypeDropdownProps) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const scale = useSharedValue(1);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const selectedItem = TEXT_TYPES.find((t) => t.id === selectedType) || TEXT_TYPES[0];

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handleSelect = (type: TextType) => {
    onSelect(type);
    setIsOpen(false);
  };

  return (
    <>
      <AnimatedPressable
        onPressIn={() => {
          scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          scale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        onPress={() => setIsOpen(true)}
        className="flex-row items-center gap-1 rounded-xl px-2.5 py-1.5"
        style={animatedStyle}
      >
        <Text className="font-roobert-medium text-sm text-foreground">
          {selectedItem.label}
        </Text>
        <Icon
          as={ChevronDown}
          size={14}
          className="text-foreground/60"
          strokeWidth={2}
        />
      </AnimatedPressable>

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsOpen(false)}
      >
        <Pressable
          className="flex-1 justify-start"
          onPress={() => setIsOpen(false)}
        >
          <Pressable
            className="mt-24 mx-4 rounded-2xl border border-border bg-card p-1 shadow-lg"
            style={{
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: isDark ? 0.3 : 0.1,
              shadowRadius: 12,
              elevation: 8,
            }}
          >
            {TEXT_TYPES.map((type) => (
              <Pressable
                key={type.id}
                onPress={() => handleSelect(type.id)}
                className={`flex-row items-center gap-3 rounded-xl px-3 py-2.5 ${selectedType === type.id ? 'bg-primary/10' : 'active:bg-muted'
                  }`}
              >
                <Icon
                  as={type.icon}
                  size={18}
                  className={selectedType === type.id ? 'text-primary' : 'text-foreground'}
                  strokeWidth={2}
                />
                <Text
                  className={`flex-1 font-roobert-medium text-sm ${selectedType === type.id ? 'text-primary' : 'text-foreground'
                    }`}
                >
                  {type.label}
                </Text>
                {selectedType === type.id && (
                  <Icon as={Check} size={16} className="text-primary" strokeWidth={2.5} />
                )}
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
});

TextTypeDropdown.displayName = 'TextTypeDropdown';

/**
 * MarkdownToolbar Component
 * 
 * A WYSIWYG-style markdown formatting toolbar for the chat input.
 * Provides quick access to common markdown formatting options.
 * Shows active state for text styles based on cursor position.
 */
export const MarkdownToolbar = React.memo(({ onFormat, isVisible, text = '', selection }: MarkdownToolbarProps) => {
  const [showTableModal, setShowTableModal] = React.useState(false);
  const [showCodeBlockModal, setShowCodeBlockModal] = React.useState(false);

  // Detect active formats based on cursor position
  const activeFormats = React.useMemo(() => {
    const cursorPos = selection?.start ?? 0;
    return detectActiveFormats(text, cursorPos);
  }, [text, selection?.start]);

  const handleTextTypeChange = React.useCallback((type: TextType) => {
    const textType = TEXT_TYPES.find((t) => t.id === type);
    if (textType && textType.prefix) {
      onFormat('heading', textType.prefix);
    }
  }, [onFormat]);

  const handleTableInsert = React.useCallback((tableMarkdown: string) => {
    // Insert the table markdown at the current cursor position
    onFormat('table', tableMarkdown);
  }, [onFormat]);

  const handleCodeBlockInsert = React.useCallback((codeBlockMarkdown: string) => {
    // Insert the code block markdown at the current cursor position
    onFormat('code-block', codeBlockMarkdown);
  }, [onFormat]);

  if (!isVisible) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(100)}
      className="border-b border-border bg-card/50"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 6 }}
        keyboardShouldPersistTaps="always"
      >
        <View className="flex-row items-center gap-0.5">
          {/* Text Type Dropdown - shows detected heading */}
          <TextTypeDropdown
            selectedType={activeFormats.heading}
            onSelect={handleTextTypeChange}
          />

          <ToolbarDivider />

          {/* Text Formatting - with active states */}
          <ToolButton
            icon={Bold}
            onPress={() => onFormat('bold')}
            isActive={activeFormats.bold}
            label="Bold"
          />
          <ToolButton
            icon={Italic}
            onPress={() => onFormat('italic')}
            isActive={activeFormats.italic}
            label="Italic"
          />
          <ToolButton
            icon={Strikethrough}
            onPress={() => onFormat('strikethrough')}
            isActive={activeFormats.strikethrough}
            label="Strikethrough"
          />
          <ToolButton
            icon={Code}
            onPress={() => onFormat('code')}
            isActive={activeFormats.code}
            label="Inline Code"
          />

          <ToolbarDivider />

          {/* Lists */}
          <ToolButton
            icon={List}
            onPress={() => onFormat('bullet-list')}
            label="Bullet List"
          />
          <ToolButton
            icon={ListOrdered}
            onPress={() => onFormat('numbered-list')}
            label="Numbered List"
          />
          <ToolButton
            icon={ListChecks}
            onPress={() => onFormat('checklist')}
            label="Checklist"
          />

          <ToolbarDivider />

          {/* Block Elements */}
          <ToolButton
            icon={Quote}
            onPress={() => onFormat('quote')}
            label="Quote"
          />
          <ToolButton
            icon={CodeSquare}
            onPress={() => setShowCodeBlockModal(true)}
            label="Code Block"
          />
          <ToolButton
            icon={Minus}
            onPress={() => onFormat('horizontal-rule')}
            label="Horizontal Rule"
          />

          <ToolbarDivider />

          {/* Table */}
          <ToolButton
            icon={Table}
            onPress={() => setShowTableModal(true)}
            label="Table"
          />
        </View>
      </ScrollView>

      {/* Table Editor Modal */}
      <TableEditorModal
        visible={showTableModal}
        onClose={() => setShowTableModal(false)}
        onInsert={handleTableInsert}
      />

      {/* Code Block Editor Modal */}
      <CodeBlockEditorModal
        visible={showCodeBlockModal}
        onClose={() => setShowCodeBlockModal(false)}
        onInsert={handleCodeBlockInsert}
      />
    </Animated.View>
  );
});

MarkdownToolbar.displayName = 'MarkdownToolbar';

/**
 * Utility function to insert markdown formatting at cursor position or wrap selected text
 */
export function insertMarkdownFormat(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  format: MarkdownFormat,
  extra?: string
): { newText: string; newCursorPosition: number; newSelectionEnd: number } {
  const hasSelection = selectionStart !== selectionEnd;
  const selectedText = hasSelection ? text.substring(selectionStart, selectionEnd) : '';
  const beforeSelection = text.substring(0, selectionStart);
  const afterSelection = text.substring(selectionEnd);

  // Get the current line info
  const lastNewlineIndex = beforeSelection.lastIndexOf('\n');
  const lineStart = lastNewlineIndex === -1 ? 0 : lastNewlineIndex + 1;
  const currentLineBeforeSelection = beforeSelection.substring(lineStart);

  // Inline formats that wrap text
  const wrapFormats: Record<string, { prefix: string; suffix: string }> = {
    bold: { prefix: '**', suffix: '**' },
    italic: { prefix: '*', suffix: '*' },
    underline: { prefix: '<u>', suffix: '</u>' },
    strikethrough: { prefix: '~~', suffix: '~~' },
    code: { prefix: '`', suffix: '`' },
  };

  // Check if this is a wrap format
  if (wrapFormats[format]) {
    const { prefix, suffix } = wrapFormats[format];

    if (hasSelection) {
      // Check if selected text is already wrapped with these markers
      const beforePrefix = beforeSelection.slice(-prefix.length);
      const afterSuffix = afterSelection.slice(0, suffix.length);

      const isAlreadyWrapped = beforePrefix === prefix && afterSuffix === suffix;

      if (isAlreadyWrapped) {
        // Unwrap: remove the markers
        const newText = beforeSelection.slice(0, -prefix.length) + selectedText + afterSelection.slice(suffix.length);
        const newCursorPosition = selectionStart - prefix.length;
        const newSelectionEnd = newCursorPosition + selectedText.length;
        return { newText, newCursorPosition, newSelectionEnd };
      } else {
        // Wrap selected text
        const newText = beforeSelection + prefix + selectedText + suffix + afterSelection;
        const newCursorPosition = selectionStart + prefix.length + selectedText.length + suffix.length;
        return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
      }
    } else {
      // Insert empty wrapper and position cursor inside
      const newText = beforeSelection + prefix + suffix + afterSelection;
      const newCursorPosition = selectionStart + prefix.length;
      return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
    }
  }

  // Handle link format specially - can use selected text as link text
  if (format === 'link') {
    if (hasSelection) {
      const newText = beforeSelection + '[' + selectedText + '](url)' + afterSelection;
      // Position cursor at "url" to let user type the URL
      const newCursorPosition = selectionStart + selectedText.length + 3;
      return { newText, newCursorPosition, newSelectionEnd: newCursorPosition + 3 };
    } else {
      const newText = beforeSelection + '[](url)' + afterSelection;
      const newCursorPosition = selectionStart + 1;
      return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
    }
  }

  // Handle code-block - can wrap selected text or use custom markdown from modal
  if (format === 'code-block') {
    // If extra contains custom code block markdown from modal, use it
    if (extra) {
      const needsNewlineBefore = currentLineBeforeSelection.length > 0;
      const insertion = needsNewlineBefore ? '\n' + extra + '\n\n' : extra + '\n\n';
      const newText = beforeSelection + insertion + afterSelection;
      const newCursorPosition = selectionStart + insertion.length;
      return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
    }

    // Default behavior when no custom markdown provided
    if (hasSelection) {
      const needsNewlineBefore = currentLineBeforeSelection.length > 0;
      const prefix = needsNewlineBefore ? '\n```\n' : '```\n';
      const suffix = '\n```\n\n';
      const newText = beforeSelection + prefix + selectedText + suffix + afterSelection;
      const newCursorPosition = selectionStart + prefix.length + selectedText.length + suffix.length;
      return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
    } else {
      if (currentLineBeforeSelection.length === 0) {
        const block = '```\n\n```\n\n';
        const newText = beforeSelection + block + afterSelection;
        // Cursor after the entire block (after the newlines)
        return { newText, newCursorPosition: selectionStart + block.length, newSelectionEnd: selectionStart + block.length };
      } else {
        const block = '\n```\n\n```\n\n';
        const newText = beforeSelection + block + afterSelection;
        // Cursor after the entire block (after the newlines)
        return { newText, newCursorPosition: selectionStart + block.length, newSelectionEnd: selectionStart + block.length };
      }
    }
  }

  // Handle quote - can wrap selected text or apply to line
  if (format === 'quote') {
    if (hasSelection) {
      // Prefix each line of selection with >
      const quotedText = selectedText.split('\n').map(line => '> ' + line).join('\n');
      const needsNewlineBefore = currentLineBeforeSelection.length > 0;
      const prefix = needsNewlineBefore ? '\n' : '';
      const newText = beforeSelection + prefix + quotedText + afterSelection;
      const newCursorPosition = selectionStart + prefix.length + quotedText.length;
      return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
    } else {
      if (currentLineBeforeSelection.length === 0) {
        const newText = beforeSelection + '> ' + afterSelection;
        return { newText, newCursorPosition: selectionStart + 2, newSelectionEnd: selectionStart + 2 };
      } else {
        const newText = beforeSelection + '\n> ' + afterSelection;
        return { newText, newCursorPosition: selectionStart + 3, newSelectionEnd: selectionStart + 3 };
      }
    }
  }

  // Handle heading - can apply to selected text
  if (format === 'heading' && extra) {
    if (hasSelection) {
      const needsNewlineBefore = currentLineBeforeSelection.length > 0;
      const prefix = needsNewlineBefore ? '\n' + extra : extra;
      const newText = beforeSelection + prefix + selectedText + afterSelection;
      const newCursorPosition = selectionStart + prefix.length + selectedText.length;
      return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
    } else {
      if (currentLineBeforeSelection.length === 0) {
        const newText = beforeSelection + extra + afterSelection;
        return { newText, newCursorPosition: selectionStart + extra.length, newSelectionEnd: selectionStart + extra.length };
      } else {
        const newText = beforeSelection + '\n' + extra + afterSelection;
        return { newText, newCursorPosition: selectionStart + extra.length + 1, newSelectionEnd: selectionStart + extra.length + 1 };
      }
    }
  }

  // Line-based formats (lists, etc.) - these don't wrap selection
  let insertion = '';
  let cursorOffset = 0;

  switch (format) {
    case 'bullet-list':
      if (hasSelection) {
        // Convert each line to a bullet point
        const bulletedText = selectedText.split('\n').map(line => '- ' + line).join('\n');
        const needsNewlineBefore = currentLineBeforeSelection.length > 0;
        const prefix = needsNewlineBefore ? '\n' : '';
        const newText = beforeSelection + prefix + bulletedText + afterSelection;
        const newCursorPosition = selectionStart + prefix.length + bulletedText.length;
        return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
      }
      if (currentLineBeforeSelection.length === 0) {
        insertion = '- ';
        cursorOffset = 2;
      } else {
        insertion = '\n- ';
        cursorOffset = 3;
      }
      break;

    case 'numbered-list':
      if (hasSelection) {
        const lines = selectedText.split('\n');
        const numberedText = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
        const needsNewlineBefore = currentLineBeforeSelection.length > 0;
        const prefix = needsNewlineBefore ? '\n' : '';
        const newText = beforeSelection + prefix + numberedText + afterSelection;
        const newCursorPosition = selectionStart + prefix.length + numberedText.length;
        return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
      }
      if (currentLineBeforeSelection.length === 0) {
        insertion = '1. ';
        cursorOffset = 3;
      } else {
        insertion = '\n1. ';
        cursorOffset = 4;
      }
      break;

    case 'checklist':
      if (hasSelection) {
        const checklistText = selectedText.split('\n').map(line => '- [ ] ' + line).join('\n');
        const needsNewlineBefore = currentLineBeforeSelection.length > 0;
        const prefix = needsNewlineBefore ? '\n' : '';
        const newText = beforeSelection + prefix + checklistText + afterSelection;
        const newCursorPosition = selectionStart + prefix.length + checklistText.length;
        return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
      }
      if (currentLineBeforeSelection.length === 0) {
        insertion = '- [ ] ';
        cursorOffset = 6;
      } else {
        insertion = '\n- [ ] ';
        cursorOffset = 7;
      }
      break;

    case 'horizontal-rule':
      if (currentLineBeforeSelection.length === 0) {
        insertion = '---\n\n';
        cursorOffset = insertion.length; // After the separator and empty line
      } else {
        insertion = '\n---\n\n';
        cursorOffset = insertion.length; // After the separator and empty line
      }
      break;

    case 'table':
      // If extra contains custom table markdown, use it; otherwise use template
      const tableTemplate = extra || `| Header 1 | Header 2 |
| -------- | -------- |
| Cell 1   | Cell 2   |`;
      if (currentLineBeforeSelection.length === 0) {
        insertion = tableTemplate + '\n\n';
        cursorOffset = insertion.length; // After table and empty line
      } else {
        insertion = '\n' + tableTemplate + '\n\n';
        cursorOffset = insertion.length; // After table and empty line
      }
      break;

    default:
      return { newText: text, newCursorPosition: selectionStart, newSelectionEnd: selectionStart };
  }

  const newText = beforeSelection + insertion + afterSelection;
  const newCursorPosition = selectionStart + cursorOffset;

  return { newText, newCursorPosition, newSelectionEnd: newCursorPosition };
}
