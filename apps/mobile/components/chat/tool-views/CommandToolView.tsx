/**
 * Command Tool View
 * 
 * Specialized view for command execution tools
 */

import React, { useState } from 'react';
import { View, ScrollView, Pressable, Clipboard } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import * as Haptics from 'expo-haptics';
import { 
  Terminal, 
  CheckCircle2, 
  AlertCircle,
  Copy,
  Check,
  ChevronDown,
  ChevronUp
} from 'lucide-react-native';
import type { ToolViewProps } from './types';

export function CommandToolView({ toolData }: ToolViewProps) {
  const { toolName, arguments: toolArgs, result } = toolData;
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const command = toolArgs.command || toolArgs.session_name || '';
  const cwd = toolArgs.cwd || '';
  const isError = !result.success;

  // Extract output from result
  const output = result.output?.output || result.output || '';
  const exitCode = result.output?.exit_code ?? result.output?.exitCode;
  const completed = result.output?.completed ?? true;

  const handleCopy = async () => {
    if (output) {
      Clipboard.setString(String(output));
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      console.log('📋 Copied command output to clipboard');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Format output: handle newlines and escape sequences
  const formattedOutput = React.useMemo(() => {
    if (!output) return '';
    let str = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    
    // Replace escape sequences
    str = str.replace(/\\n/g, '\n')
             .replace(/\\t/g, '\t')
             .replace(/\\"/g, '"')
             .replace(/\\\\/g, '\\');
    
    return str;
  }, [output]);

  const outputLines = formattedOutput.split('\n');
  const hasLongOutput = outputLines.length > 20;

  return (
    <View className="px-6 py-4 gap-6">
      {/* Header */}
      <View className="flex-row items-center gap-3">
        <View className="bg-primary/10 rounded-2xl items-center justify-center" style={{ width: 48, height: 48 }}>
          <Icon as={Terminal} size={24} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider mb-1">
            {toolName === 'check-command-output' ? 'Check Output' : 'Execute Command'}
          </Text>
          <Text className="text-xl font-roobert-semibold text-foreground">
            Terminal
          </Text>
        </View>
      </View>

      {/* Command */}
      <View className="gap-2">
        <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
          {toolName === 'check-command-output' ? 'Session' : 'Command'}
        </Text>
        <View className="bg-card border border-border rounded-2xl p-4">
          <Text className="text-sm font-roobert text-foreground" selectable>
            {toolName === 'check-command-output' ? `tmux:${command}` : `$ ${command}`}
          </Text>
        </View>
      </View>

      {/* Working Directory */}
      {cwd && (
        <View className="gap-2">
          <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
            Working Directory
          </Text>
          <View className="bg-card border border-border rounded-2xl p-4">
            <Text className="text-sm font-roobert text-foreground" selectable>
              {cwd}
            </Text>
          </View>
        </View>
      )}

      {/* Output */}
      {formattedOutput && (
        <View className="gap-2">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
                Output
              </Text>
              {!completed && (
                <View className="bg-primary/10 border border-primary/20 rounded-full px-2.5 py-0.5">
                  <Text className="text-xs font-roobert-medium text-primary">Running...</Text>
                </View>
              )}
            </View>
            <View className="flex-row items-center gap-2">
              {hasLongOutput && (
                <Pressable
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setExpanded(!expanded);
                  }}
                  className="flex-row items-center gap-1.5 bg-secondary active:bg-secondary/80 px-3 py-1.5 rounded-full"
                >
                  <Icon 
                    as={expanded ? ChevronUp : ChevronDown} 
                    size={14} 
                    className="text-foreground/60" 
                  />
                  <Text className="text-xs font-roobert-medium text-foreground/60">
                    {expanded ? 'Collapse' : 'Expand'}
                  </Text>
                </Pressable>
              )}
              <Pressable
                onPress={handleCopy}
                className="flex-row items-center gap-1.5 bg-secondary active:bg-secondary/80 px-3 py-1.5 rounded-full"
              >
                <Icon 
                  as={copied ? Check : Copy} 
                  size={14} 
                  className={copied ? 'text-primary' : 'text-foreground/60'} 
                />
                <Text className={`text-xs font-roobert-medium ${
                  copied ? 'text-primary' : 'text-foreground/60'
                }`}>
                  {copied ? 'Copied!' : 'Copy'}
                </Text>
              </Pressable>
            </View>
          </View>

          <View className={`rounded-2xl p-4 border ${
            isError 
              ? 'bg-destructive/5 border-destructive/20' 
              : 'bg-card border-border'
          }`} style={{ maxHeight: expanded ? 400 : 160 }}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text className="text-sm font-roobert text-foreground/80 leading-5" selectable>
                {formattedOutput}
              </Text>
            </ScrollView>
          </View>

          <View className="flex-row items-center gap-2">
            <View className="bg-card border border-border rounded-full px-3 py-1">
              <Text className="text-xs font-roobert-medium text-foreground/60">
                {outputLines.length} lines
              </Text>
            </View>
            {exitCode !== undefined && exitCode !== null && (
              <View className={`rounded-full px-3 py-1 border ${
                exitCode === 0 
                  ? 'bg-primary/10 border-primary/20' 
                  : 'bg-destructive/10 border-destructive/20'
              }`}>
                <Text className={`text-xs font-roobert-medium ${
                  exitCode === 0 ? 'text-primary' : 'text-destructive'
                }`}>
                  Exit code: {exitCode}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Status */}
      <View className="gap-2">
        <Text className="text-xs font-roobert-medium text-foreground/50 uppercase tracking-wider">
          Status
        </Text>
        <View className={`flex-row items-center gap-2 rounded-2xl p-4 border ${
          isError 
            ? 'bg-destructive/5 border-destructive/20' 
            : 'bg-primary/5 border-primary/20'
        }`}>
          <Icon 
            as={isError ? AlertCircle : CheckCircle2} 
            size={18} 
            className={isError ? 'text-destructive' : 'text-primary'} 
          />
          <Text className={`text-sm font-roobert-medium ${
            isError ? 'text-destructive' : 'text-primary'
          }`}>
            {isError ? 'Command Failed' : completed ? 'Command Completed' : 'Command Running'}
          </Text>
        </View>
      </View>
    </View>
  );
}
