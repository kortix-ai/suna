import React, { useMemo, useState, useCallback, useRef } from 'react';
import { View, Pressable, StyleSheet, Keyboard, Modal, TextInput, ScrollView, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Copy, Check, Edit3, X, Trash2 } from 'lucide-react-native';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import {
  markdownParser,
  lightMarkdownStyle,
  darkMarkdownStyle,
} from '@/lib/utils/live-markdown-config';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

interface HybridMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSelectionChange?: (event: { nativeEvent: { selection: { start: number; end: number } } }) => void;
  editable: boolean;
  isDark: boolean;
  markdownInputRef?: React.RefObject<any>;
  isEditing: boolean; // NEW: Determines if we're in edit mode or preview mode
}

interface ContentPart {
  type: 'markdown' | 'codeblock' | 'table' | 'separator';
  content: string;
  language?: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Parse markdown content into parts (code blocks, tables, separators, regular markdown)
 * Now also calculates proper startIndex/endIndex for cursor mapping
 */
function parseMarkdownParts(text: string): ContentPart[] {
  if (!text || !text.trim()) {
    return [{ type: 'markdown', content: text || '', startIndex: 0, endIndex: text?.length || 0 }];
  }

  const parts: ContentPart[] = [];
  const lines = text.split('\n');
  let i = 0;
  let charOffset = 0; // Track position in original text

  // Helper to calculate char offset at line index
  const getCharOffsetAtLine = (lineIndex: number): number => {
    let offset = 0;
    for (let j = 0; j < lineIndex && j < lines.length; j++) {
      offset += lines[j].length + 1; // +1 for \n
    }
    return offset;
  };

  while (i < lines.length) {
    const line = lines[i];
    const lineStartOffset = getCharOffsetAtLine(i);

    // Check for code block start
    if (line.trim().startsWith('```')) {
      const blockStartOffset = lineStartOffset;
      const language = line.trim().substring(3).trim();
      const codeLines: string[] = [];
      i++; // Move past opening ```

      // Collect code lines until closing ```
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }

      const blockEndOffset = getCharOffsetAtLine(i) + (lines[i]?.length || 0);
      i++; // Move past closing ```

      parts.push({
        type: 'codeblock',
        content: codeLines.join('\n'),
        language: language || undefined,
        startIndex: blockStartOffset,
        endIndex: blockEndOffset,
      });
      continue;
    }

    // Check for separator
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      parts.push({
        type: 'separator',
        content: line.trim(),
        startIndex: lineStartOffset,
        endIndex: lineStartOffset + line.length,
      });
      i++;
      continue;
    }

    // Check for table start (line with | and next line is separator row)
    const nextLine = lines[i + 1];
    if (line.trim().includes('|') && nextLine && /^\|?[\s:|-]+\|[\s:|-]+/.test(nextLine.trim())) {
      const tableStartOffset = lineStartOffset;
      const tableLines = [line, nextLine];
      i += 2; // Move past header and separator

      // Collect remaining table rows
      while (i < lines.length && lines[i].trim().includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }

      const tableEndOffset = getCharOffsetAtLine(i - 1) + (lines[i - 1]?.length || 0);

      parts.push({
        type: 'table',
        content: tableLines.join('\n'),
        startIndex: tableStartOffset,
        endIndex: tableEndOffset,
      });
      continue;
    }

    // Regular markdown line - collect consecutive markdown lines
    const markdownStartOffset = lineStartOffset;
    const markdownLines = [line];
    i++;

    while (i < lines.length) {
      const nextLine = lines[i];

      // Stop if we hit a special element
      if (
        nextLine.trim().startsWith('```') ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(nextLine.trim()) ||
        (nextLine.trim().includes('|') && lines[i + 1] && /^\|?[\s:|-]+\|[\s:|-]+/.test(lines[i + 1].trim()))
      ) {
        break;
      }

      markdownLines.push(nextLine);
      i++;
    }

    const markdownContent = markdownLines.join('\n');
    const trimmedContent = markdownContent.trim();

    // Always include markdown parts, even if empty, so users can type after special elements
    // Calculate the actual start offset accounting for leading whitespace trim
    const leadingWhitespace = markdownContent.length - markdownContent.trimStart().length;
    const actualStartOffset = markdownStartOffset + leadingWhitespace;
    const actualEndOffset = actualStartOffset + trimmedContent.length;

    parts.push({
      type: 'markdown',
      content: trimmedContent,
      startIndex: actualStartOffset,
      endIndex: actualEndOffset,
    });
  }

  return parts.length > 0 ? parts : [{ type: 'markdown', content: text, startIndex: 0, endIndex: text.length }];
}

/**
 * Code Block Component with Edit/Delete Support
 */
function CodeBlock({
  code,
  language,
  isDark,
  editable,
  onEdit,
  onDelete,
}: {
  code: string;
  language?: string;
  isDark: boolean;
  editable?: boolean;
  onEdit?: (newCode: string, newLanguage?: string) => void;
  onDelete?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editCode, setEditCode] = useState(code);
  const [editLanguage, setEditLanguage] = useState(language || '');

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  };

  const handleEdit = () => {
    setEditCode(code);
    setEditLanguage(language || '');
    setShowEditModal(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Code Block',
      'Are you sure you want to delete this code block?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            onDelete?.();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
      ]
    );
  };

  const handleSave = () => {
    onEdit?.(editCode, editLanguage || undefined);
    setShowEditModal(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <>
      <View className="border border-border rounded-3xl overflow-hidden bg-card">
        <View className="flex-row justify-between items-center px-4 py-3 border-b border-border">
          {language && (
            <Text className="text-xs font-roobert-medium text-primary opacity-60 uppercase">
              {language}
            </Text>
          )}
          <View className="flex-row gap-2">
            {editable && (
              <>
                <Pressable
                  onPress={handleEdit}
                  className="px-3 py-1.5 rounded-lg bg-card border border-border active:opacity-70">
                  <Icon as={Edit3} size={14} className="text-primary" />
                </Pressable>
                <Pressable
                  onPress={handleDelete}
                  className="px-3 py-1.5 rounded-lg bg-card border border-border active:opacity-70">
                  <Icon as={Trash2} size={14} className="text-red-500" />
                </Pressable>
              </>
            )}
            {!editable && (
              <Pressable
                onPress={handleCopy}
                className="px-3 py-1.5 rounded-lg bg-card border border-border active:opacity-70">
                <Icon as={copied ? Check : Copy} size={14} className="text-primary" />
              </Pressable>
            )}
          </View>
        </View>
        <Text className="font-roobert-mono text-sm text-primary p-4 leading-5" selectable>
          {code}
        </Text>
      </View>

      {/* Edit Modal */}
      <Modal
        visible={showEditModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowEditModal(false)}
      >
        <View className="flex-1 bg-background">
          <View className="flex-row justify-between items-center px-5 py-4 border-b border-border">
            <Text className="text-xl font-roobert-semibold text-primary">Edit Code Block</Text>
            <Pressable onPress={() => setShowEditModal(false)} className="p-2">
              <Icon as={X} size={24} className="text-primary" />
            </Pressable>
          </View>

          <ScrollView className="flex-1 px-5 py-4">
            <Text className="text-sm font-roobert-semibold text-primary mb-2">
              Language (optional)
            </Text>
            <TextInput
              value={editLanguage}
              onChangeText={setEditLanguage}
              placeholder="e.g., javascript, python, typescript"
              placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
              className="px-4 py-3 rounded-xl border border-border bg-card text-primary font-roobert text-base mb-5"
            />

            <Text className="text-sm font-roobert-semibold text-primary mb-2">
              Code
            </Text>
            <TextInput
              value={editCode}
              onChangeText={setEditCode}
              multiline
              placeholder="Enter your code here..."
              placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
              className="px-4 py-3 rounded-xl border border-border bg-card text-primary font-roobert-mono text-sm"
              style={{ minHeight: 300, textAlignVertical: 'top' }}
            />
          </ScrollView>

          <View className="flex-row gap-3 px-5 py-4 border-t border-border">
            <Pressable
              onPress={() => setShowEditModal(false)}
              className="flex-1 py-3.5 rounded-xl items-center bg-card border border-border active:opacity-70"
            >
              <Text className="text-base font-roobert-semibold text-primary">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              className="flex-1 py-3.5 rounded-xl items-center bg-primary active:opacity-70"
            >
              <Text className="text-base font-roobert-semibold text-background">Save</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

/**
 * Table Component with Edit/Delete Support
 */
function SimpleTable({
  text,
  isDark,
  editable,
  onEdit,
  onDelete,
}: {
  text: string;
  isDark: boolean;
  editable?: boolean;
  onEdit?: (newTable: string) => void;
  onDelete?: () => void;
}) {
  const [showEditModal, setShowEditModal] = useState(false);
  const [editText, setEditText] = useState(text);

  const handleEdit = () => {
    setEditText(text);
    setShowEditModal(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleDelete = () => {
    Alert.alert(
      'Delete Table',
      'Are you sure you want to delete this table?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            onDelete?.();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
      ]
    );
  };

  const handleSave = () => {
    onEdit?.(editText);
    setShowEditModal(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const lines = text.split('\n');

  return (
    <>
      <View className="border border-border rounded-3xl overflow-hidden bg-card">
        {editable && (
          <View className="px-4 py-2 border-b border-border flex-row justify-end gap-2">
            <Pressable
              onPress={handleEdit}
              className="px-3 py-1.5 rounded-lg bg-card border border-border active:opacity-70"
            >
              <Icon as={Edit3} size={14} className="text-primary" />
            </Pressable>
            <Pressable
              onPress={handleDelete}
              className="px-3 py-1.5 rounded-lg bg-card border border-border active:opacity-70"
            >
              <Icon as={Trash2} size={14} className="text-red-500" />
            </Pressable>
          </View>
        )}
        {lines.map((line, idx) => {
          if (!line.includes('|')) return null;

          const cells = line.split('|').filter((cell) => cell.trim());
          const isSeparator = /^[\s:|-]+$/.test(cells[0]);

          if (isSeparator) return null;

          const isHeader = idx === 0;

          return (
            <View
              key={idx}
              className={`flex-row border-b border-border ${isHeader ? 'bg-card' : ''}`}>
              {cells.map((cell, cellIdx) => (
                <View
                  key={cellIdx}
                  className={`flex-1 p-3 border-r border-border ${isHeader ? 'bg-muted/30' : ''}`}>
                  <Text
                    className={`text-sm text-primary ${isHeader ? 'font-roobert-semibold' : 'font-roobert'}`}
                    selectable>
                    {cell.trim()}
                  </Text>
                </View>
              ))}
            </View>
          );
        })}
      </View>

      {/* Edit Modal */}
      <Modal
        visible={showEditModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowEditModal(false)}
      >
        <View className="flex-1 bg-background">
          <View className="flex-row justify-between items-center px-5 py-4 border-b border-border">
            <Text className="text-xl font-roobert-semibold text-primary">Edit Table</Text>
            <Pressable onPress={() => setShowEditModal(false)} className="p-2">
              <Icon as={X} size={24} className="text-primary" />
            </Pressable>
          </View>

          <ScrollView className="flex-1 px-5 py-4">
            <Text className="text-sm font-roobert-semibold text-primary mb-2">
              Table Markdown
            </Text>
            <TextInput
              value={editText}
              onChangeText={setEditText}
              multiline
              placeholder="| Header 1 | Header 2 |&#10;|----------|----------|&#10;| Cell 1   | Cell 2   |"
              placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
              className="px-4 py-3 rounded-xl border border-border bg-card text-primary font-roobert-mono text-sm"
              style={{ minHeight: 300, textAlignVertical: 'top' }}
            />
          </ScrollView>

          <View className="flex-row gap-3 px-5 py-4 border-t border-border">
            <Pressable
              onPress={() => setShowEditModal(false)}
              className="flex-1 py-3.5 rounded-xl items-center bg-card border border-border active:opacity-70"
            >
              <Text className="text-base font-roobert-semibold text-primary">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              className="flex-1 py-3.5 rounded-xl items-center bg-primary active:opacity-70"
            >
              <Text className="text-base font-roobert-semibold text-background">Save</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

/**
 * Separator Component with Delete Support
 */
function Separator({ editable, onDelete }: { editable?: boolean; onDelete?: () => void }) {
  const handleDelete = () => {
    onDelete?.();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  if (editable) {
    return (
      <View className="flex-row items-center gap-3 my-4">
        <View className="flex-1 h-px bg-border" />
        <Pressable
          onPress={handleDelete}
          className="w-6 h-6 rounded-full items-center justify-center bg-card border border-border active:opacity-70"
        >
          <Icon as={X} size={12} className="text-red-500" />
        </Pressable>
        <View className="flex-1 h-px bg-border" />
      </View>
    );
  }

  return <View className="h-px bg-border my-4" />;
}

/**
 * Hybrid Markdown Editor
 * 
 * EDIT MODE: Pure markdown editing with live preview (no custom components)
 * PREVIEW MODE: Rich rendered components (code blocks, tables, separators)
 */
export function HybridMarkdownEditor({
  value,
  onChange,
  onSelectionChange,
  editable,
  isDark,
  markdownInputRef,
  isEditing,
}: HybridMarkdownEditorProps) {
  // Track which markdown part is currently focused for selection mapping
  const [focusedPartIndex, setFocusedPartIndex] = useState<number | null>(null);

  // Track which part is actively being typed in (starts on first keystroke, not focus)
  const [typingPartIndex, setTypingPartIndex] = useState<number | null>(null);

  // Parse parts
  const parts = useMemo(() => {
    const parsed = parseMarkdownParts(value);
    return parsed;
  }, [value]);

  // Handle local selection change from a markdown part and convert to global position
  const handlePartSelectionChange = useCallback((
    partIndex: number,
    localSelection: { start: number; end: number }
  ) => {
    const part = parts[partIndex];
    if (!part || part.type !== 'markdown') return;

    // Convert local selection to global by adding the part's start offset
    const globalSelection = {
      start: part.startIndex + localSelection.start,
      end: part.startIndex + localSelection.end,
    };

    // Call parent's onSelectionChange with the global coordinates
    onSelectionChange?.({
      nativeEvent: { selection: globalSelection }
    });

    setFocusedPartIndex(partIndex);
  }, [parts, onSelectionChange]);

  // Handle editing a specific part
  const handlePartEdit = useCallback((partIndex: number, newContent: string, newLanguage?: string) => {
    const part = parts[partIndex];
    if (!part) return;

    // For markdown parts, directly replace content in original text to preserve spacing
    if (part.type === 'markdown' && !newLanguage) {
      // Calculate the actual content boundaries
      const before = value.substring(0, part.startIndex);
      const after = value.substring(part.endIndex);
      const newText = before + newContent + after;
      onChange(newText);
      return;
    }

    // For other types (codeblock, table), reconstruct with proper spacing
    const newParts = parts.map((p, i) => {
      if (i === partIndex) {
        if (p.type === 'codeblock') {
          return `\`\`\`${newLanguage || p.language || ''}\n${newContent}\n\`\`\``;
        } else if (p.type === 'table') {
          return newContent;
        } else if (p.type === 'separator') {
          return p.content;
        } else {
          return newContent;
        }
      } else {
        if (p.type === 'codeblock') {
          return `\`\`\`${p.language || ''}\n${p.content}\n\`\`\``;
        } else if (p.type === 'separator') {
          return p.content;
        } else if (p.type === 'table') {
          return p.content;
        } else {
          return p.content;
        }
      }
    });

    onChange(newParts.join('\n\n'));
  }, [parts, onChange, value]);

  // Handle deleting a part
  const handlePartDelete = useCallback((partIndex: number) => {
    const newParts = parts
      .filter((_, i) => i !== partIndex)
      .map((p) => {
        if (p.type === 'codeblock') {
          return `\`\`\`${p.language || ''}\n${p.content}\n\`\`\``;
        } else if (p.type === 'separator') {
          return p.content;
        } else if (p.type === 'table') {
          return p.content;
        } else {
          return p.content;
        }
      });

    onChange(newParts.length > 0 ? newParts.join('\n\n') : '');
  }, [parts, onChange]);

  // Handle markdown part editing inline
  const handleMarkdownEdit = useCallback((partIndex: number, newContent: string) => {
    handlePartEdit(partIndex, newContent);
  }, [handlePartEdit]);

  // Determine if we should use simple or complex rendering
  const hasNoSpecialBlocks = parts.length === 1 && parts[0].type === 'markdown';
  const isEditMode = editable && isEditing;

  // Simple case: no special blocks - use single input
  if (hasNoSpecialBlocks) {
    return (
      <View style={styles.container}>
        <MarkdownTextInput
          ref={markdownInputRef}
          value={value}
          onChangeText={editable && isEditing ? onChange : () => { }}
          onSelectionChange={onSelectionChange}
          parser={markdownParser}
          markdownStyle={isDark ? darkMarkdownStyle : lightMarkdownStyle}
          multiline
          scrollEnabled={false}
          editable={editable && isEditing}
          caretHidden={!(editable && isEditing)}
          showSoftInputOnFocus={editable && isEditing}
          style={[
            styles.previewModeInput,
            {
              color: isDark ? '#fafafa' : '#18181b',
            },
          ]}
          textAlignVertical="top"
          placeholder={editable && isEditing ? "Start typing markdown..." : ""}
          placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
        />
      </View>
    );
  }

  // PREVIEW mode: show rich custom components
  return (
    <View style={styles.container}>
      {parts.length === 0 && <Text className="text-primary">No parts parsed</Text>}
      {parts.map((part, index) => {
        const needsSpacing = index > 0 && part.content.trim().length > 0;

        if (part.type === 'codeblock') {
          return (
            <View key={`part-${index}`} style={needsSpacing && styles.partSpacing}>
              <CodeBlock
                code={part.content}
                language={part.language}
                isDark={isDark}
                editable={isEditMode} // Show edit/delete buttons in edit mode
                onEdit={(newCode, newLang) => handlePartEdit(index, newCode, newLang)}
                onDelete={() => handlePartDelete(index)}
              />
            </View>
          );
        }

        if (part.type === 'table') {
          return (
            <View key={`part-${index}`} style={needsSpacing && styles.partSpacing}>
              <SimpleTable
                text={part.content}
                isDark={isDark}
                editable={isEditMode} // Show edit/delete buttons in edit mode
                onEdit={(newTable) => handlePartEdit(index, newTable)}
                onDelete={() => handlePartDelete(index)}
              />
            </View>
          );
        }

        if (part.type === 'separator') {
          return (
            <View key={`part-${index}`} style={needsSpacing && styles.partSpacing}>
              <Separator
                editable={isEditMode} // Show delete button in edit mode
                onDelete={() => handlePartDelete(index)}
              />
            </View>
          );
        }

        // Markdown part - editable in edit mode
        // Allow empty parts in edit mode so users can type after special elements
        const isEmpty = !part.content.trim();
        if (isEmpty && !isEditMode) {
          return null;
        }

        const handleLocalChange = (text: string) => {
          if (!isEditMode) return;
          handleMarkdownEdit(index, text);
        };

        // Use stable key, but change it when switching between edit/preview to force reset
        const inputKey = isEditMode
          ? `markdown-${index}-edit`
          : `markdown-${index}-preview`;

        return (
          <View key={`part-${index}`} style={needsSpacing && styles.partSpacing}>
            <MarkdownTextInput
              key={inputKey}
              value={isEditMode ? undefined : part.content}
              defaultValue={isEditMode ? part.content : undefined}
              onChangeText={handleLocalChange}
              onSelectionChange={isEditMode ? (e) => {
                handlePartSelectionChange(index, e.nativeEvent.selection);
              } : undefined}
              onFocus={() => {
                setFocusedPartIndex(index);
              }}
              onBlur={() => {
                // Nothing needed here anymore
              }}
              parser={markdownParser}
              markdownStyle={isDark ? darkMarkdownStyle : lightMarkdownStyle}
              multiline
              scrollEnabled={false}
              editable={isEditMode}
              caretHidden={!isEditMode}
              showSoftInputOnFocus={isEditMode}
              selectTextOnFocus={false}
              style={[
                styles.previewMarkdown,
                {
                  color: isDark ? '#fafafa' : '#18181b',
                  minHeight: isEmpty && isEditMode ? 40 : undefined,
                },
              ]}
              textAlignVertical="top"
              placeholder={isEmpty && isEditMode ? "Type here..." : isEditMode ? "Type markdown here..." : ""}
              placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  partSpacing: {
    marginTop: 16,
  },
  editModeInput: {
    fontSize: 16,
    lineHeight: 24,
    padding: 0,
    margin: 0,
    minHeight: 400,
  },
  previewModeInput: {
    fontSize: 16,
    lineHeight: 24,
    padding: 0,
    margin: 0,
    minHeight: 100,
  },
  previewMarkdown: {
    fontSize: 16,
    lineHeight: 24,
    padding: 0,
    margin: 0,
  },
});

