import React, { useState, useCallback } from 'react';
import { View, Pressable, Modal, ScrollView, TextInput } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { X, Check, ChevronDown } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';

interface CodeBlockEditorModalProps {
  visible: boolean;
  onClose: () => void;
  onInsert: (codeMarkdown: string) => void;
  initialData?: {
    code: string;
    language: string;
  };
}

const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'php', label: 'PHP' },
  { id: 'swift', label: 'Swift' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'sql', label: 'SQL' },
  { id: 'bash', label: 'Bash' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'markdown', label: 'Markdown' },
  { id: '', label: 'Plain Text' },
];

export function CodeBlockEditorModal({ visible, onClose, onInsert, initialData }: CodeBlockEditorModalProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [showLanguagePicker, setShowLanguagePicker] = useState(false);

  // Initialize with existing data or defaults when modal opens
  React.useEffect(() => {
    if (visible) {
      if (initialData) {
        setCode(initialData.code);
        setLanguage(initialData.language || 'javascript');
      } else {
        setCode('');
        setLanguage('javascript');
      }
    }
  }, [visible, initialData]);

  const selectedLanguage = LANGUAGES.find(l => l.id === language) || LANGUAGES[0];

  const handleLanguageSelect = useCallback((langId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setLanguage(langId);
    setShowLanguagePicker(false);
  }, []);

  const generateCodeBlockMarkdown = useCallback(() => {
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }, [code, language]);

  const handleInsert = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const markdown = generateCodeBlockMarkdown();
    onInsert(markdown);
    onClose();
  }, [generateCodeBlockMarkdown, onInsert, onClose]);

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
            {initialData ? 'Edit Code Block' : 'Create Code Block'}
          </Text>
          <Pressable
            onPress={onClose}
            className="h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
          >
            <Icon as={X} size={17} className="text-primary" strokeWidth={2} />
          </Pressable>
        </View>

        <ScrollView className="flex-1">
          <View className="p-4 gap-4">
            {/* Language Selector */}
            <View>
              <Text className="text-xs font-roobert-medium text-primary opacity-50 uppercase tracking-wider mb-2">
                Language
              </Text>
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setShowLanguagePicker(true);
                }}
                className="flex-row items-center justify-between px-4 py-3 rounded-xl bg-card border border-border active:opacity-70"
              >
                <Text className="text-sm font-roobert-medium text-primary">
                  {selectedLanguage.label}
                </Text>
                <Icon as={ChevronDown} size={16} className="text-primary opacity-50" strokeWidth={2} />
              </Pressable>
            </View>

            {/* Code Editor */}
            <View>
              <Text className="text-xs font-roobert-medium text-primary opacity-50 uppercase tracking-wider mb-2">
                Code
              </Text>
              <View className="rounded-xl border border-border bg-card overflow-hidden">
                <TextInput
                  value={code}
                  onChangeText={setCode}
                  placeholder="Enter your code here..."
                  placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
                  multiline
                  className="px-4 py-3 text-primary font-roobert-mono text-sm"
                  style={{
                    minHeight: 300,
                    maxHeight: 500,
                    textAlignVertical: 'top',
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                />
              </View>
            </View>
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
              {initialData ? 'Save Changes' : 'Insert Code Block'}
            </Text>
          </Pressable>
        </View>

        {/* Language Picker Modal */}
        <Modal
          visible={showLanguagePicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowLanguagePicker(false)}
        >
          <Pressable
            className="flex-1 bg-background/80 justify-center px-4"
            onPress={() => setShowLanguagePicker(false)}
          >
            <View className="bg-card rounded-2xl border border-border overflow-hidden max-h-[60vh]">
              <View className="px-4 py-3 border-b border-border">
                <Text className="text-base font-roobert-semibold text-primary">Select Language</Text>
              </View>
              <ScrollView>
                {LANGUAGES.map((lang) => (
                  <Pressable
                    key={lang.id}
                    onPress={() => handleLanguageSelect(lang.id)}
                    className={`px-4 py-3 border-b border-border active:opacity-70 ${language === lang.id ? 'bg-primary/10' : ''
                      }`}
                  >
                    <Text
                      className={`text-sm font-roobert ${language === lang.id ? 'text-primary font-roobert-semibold' : 'text-primary'
                        }`}
                    >
                      {lang.label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>
      </View>
    </Modal>
  );
}
