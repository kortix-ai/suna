import React, { useState, useCallback } from 'react';
import { View, Pressable, Modal, ScrollView, TextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, Plus, Trash2, Check } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';

interface TableEditorModalProps {
  visible: boolean;
  onClose: () => void;
  onInsert: (tableMarkdown: string) => void;
  initialData?: {
    headers: string[];
    cells: string[][];
  };
}

export function TableEditorModal({ visible, onClose, onInsert, initialData }: TableEditorModalProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [headers, setHeaders] = useState<string[]>(['Header 1', 'Header 2']);
  const [cells, setCells] = useState<string[][]>([
    ['Cell 1', 'Cell 2'],
    ['Cell 3', 'Cell 4'],
  ]);

  // Initialize with existing data or defaults when modal opens
  React.useEffect(() => {
    if (visible) {
      if (initialData) {
        setHeaders(initialData.headers);
        setCells(initialData.cells);
      } else {
        setHeaders(['Header 1', 'Header 2']);
        setCells([
          ['Cell 1', 'Cell 2'],
          ['Cell 3', 'Cell 4'],
        ]);
      }
    }
  }, [visible, initialData]);

  const handleHeaderChange = useCallback((index: number, value: string) => {
    setHeaders(prev => {
      const newHeaders = [...prev];
      newHeaders[index] = value;
      return newHeaders;
    });
  }, []);

  const handleCellChange = useCallback((rowIndex: number, colIndex: number, value: string) => {
    setCells(prev => {
      const newCells = [...prev];
      newCells[rowIndex] = [...newCells[rowIndex]];
      newCells[rowIndex][colIndex] = value;
      return newCells;
    });
  }, []);

  const handleAddColumn = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setHeaders(prev => [...prev, `Header ${prev.length + 1}`]);
    setCells(prev => prev.map(row => [...row, '']));
  }, []);

  const handleAddRow = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCells(prev => [...prev, Array(headers.length).fill('')]);
  }, [headers.length]);

  const handleRemoveColumn = useCallback((colIndex: number) => {
    if (headers.length <= 1) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setHeaders(prev => prev.filter((_, i) => i !== colIndex));
    setCells(prev => prev.map(row => row.filter((_, i) => i !== colIndex)));
  }, [headers.length]);

  const handleRemoveRow = useCallback((rowIndex: number) => {
    if (cells.length <= 1) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCells(prev => prev.filter((_, i) => i !== rowIndex));
  }, [cells.length]);

  const generateTableMarkdown = useCallback(() => {
    const headerRow = '| ' + headers.join(' | ') + ' |';
    const separator = '| ' + headers.map(() => '--------').join(' | ') + ' |';
    const dataRows = cells.map(row => '| ' + row.map(cell => cell || '').join(' | ') + ' |').join('\n');
    return `${headerRow}\n${separator}\n${dataRows}`;
  }, [headers, cells]);

  const handleInsert = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const markdown = generateTableMarkdown();
    onInsert(markdown);
    onClose();
  }, [generateTableMarkdown, onInsert, onClose]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-background">
        {/* Header */}
        <View className="px-4 py-3 border-b border-border bg-card flex-row items-center justify-between">
          <Text className="text-lg font-roobert-semibold text-primary">
            {initialData ? 'Edit Table' : 'Create Table'}
          </Text>
          <Pressable
            onPress={onClose}
            className="h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
          >
            <Icon as={X} size={17} className="text-primary" strokeWidth={2} />
          </Pressable>
        </View>

        <ScrollView className="flex-1" contentContainerStyle={{ paddingTop: 16 }}>
          <View className="px-4">
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={true}
              contentContainerStyle={{ paddingBottom: 16 }}
            >
              <View style={{ paddingTop: 8 }}>
                {/* Header Row with Delete Buttons */}
                <View className="flex-row mb-3">
                  {headers.map((header, index) => (
                    <View key={`header-${index}`} className="mr-3" style={{ position: 'relative' }}>
                      <View className="w-[180px]">
                        <TextInput
                          value={header}
                          onChangeText={(text) => handleHeaderChange(index, text)}
                          placeholder={`Header ${index + 1}`}
                          placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
                          className="px-4 py-3 rounded-xl bg-primary/5 border border-border text-primary font-roobert-semibold text-sm"
                          style={{
                            minHeight: 44,
                            textAlignVertical: 'center',
                          }}
                          multiline={false}
                          numberOfLines={1}
                        />
                        {headers.length > 1 && (
                          <Pressable
                            onPress={() => handleRemoveColumn(index)}
                            className="absolute -top-1 -right-1 h-7 w-7 items-center justify-center rounded-full bg-card border border-border active:opacity-70"
                          >
                            <Icon as={Trash2} size={12} className="text-red-500" strokeWidth={2.5} />
                          </Pressable>
                        )}
                      </View>
                    </View>
                  ))}

                  {/* Add Column Button */}
                  <Pressable
                    onPress={handleAddColumn}
                    className="items-center justify-center rounded-xl bg-card border border-border border-dashed active:opacity-70"
                    style={{ height: 44, width: 44 }}
                  >
                    <Icon as={Plus} size={20} className="text-primary" strokeWidth={2.5} />
                  </Pressable>
                </View>

                {/* Data Rows */}
                {cells.map((row, rowIndex) => (
                  <View key={`row-${rowIndex}`} className="flex-row mb-3">
                    {row.map((cell, colIndex) => (
                      <View key={`cell-${rowIndex}-${colIndex}`} className="mr-3 w-[180px]">
                        <TextInput
                          value={cell}
                          onChangeText={(text) => handleCellChange(rowIndex, colIndex, text)}
                          placeholder="Cell"
                          placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
                          className="px-4 py-3 rounded-xl bg-background border border-border text-primary text-sm"
                          style={{
                            minHeight: 44,
                            maxHeight: 88,
                            textAlignVertical: 'top',
                          }}
                          multiline={true}
                          scrollEnabled={false}
                        />
                      </View>
                    ))}

                    {/* Delete Row Button */}
                    {cells.length > 1 && (
                      <Pressable
                        onPress={() => handleRemoveRow(rowIndex)}
                        className="items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
                        style={{ height: 44, width: 44 }}
                      >
                        <Icon as={Trash2} size={15} className="text-red-500" strokeWidth={2.5} />
                      </Pressable>
                    )}
                  </View>
                ))}

                {/* Add Row Button */}
                <Pressable
                  onPress={handleAddRow}
                  className="items-center justify-center rounded-xl bg-card border border-border border-dashed active:opacity-70 mt-1"
                  style={{
                    height: 44,
                    width: headers.length * 192 + (cells.length > 1 ? 44 : 0)
                  }}
                >
                  <Icon as={Plus} size={20} className="text-primary" strokeWidth={2.5} />
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </ScrollView>

        {/* Footer */}
        <View className="px-4 pb-6 pt-4 border-t border-border bg-card">
          <Pressable
            onPress={handleInsert}
            className="h-12 rounded-xl bg-primary items-center justify-center flex-row gap-2 active:opacity-90"
          >
            <Icon as={Check} size={18} className="text-background" strokeWidth={2} />
            <Text className="text-base font-roobert-semibold text-background">
              {initialData ? 'Save Changes' : 'Insert Table'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
