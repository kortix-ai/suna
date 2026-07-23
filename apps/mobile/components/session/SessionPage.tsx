/** ACP-only session chat entry point for mobile. */
import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { AcpSessionPage } from './AcpSessionPage';

interface SessionPageProps {
  sessionId: string;
  projectId?: string;
  runtimeSessionId?: string | null;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
  onboardingMode?: boolean;
  onSkipOnboarding?: () => void;
}

export function SessionPage({ projectId, sessionId, runtimeSessionId, onBack }: SessionPageProps) {
  if (!projectId) {
    return (
      <View className="bg-background flex-1 items-center justify-center px-8">
        <Text className="text-foreground text-center text-base font-medium">Open a project session</Text>
        <Text className="text-muted-foreground mt-2 text-center text-sm">
          Agent conversations now run through a project-scoped ACP session.
        </Text>
      </View>
    );
  }
  return (
    <AcpSessionPage
      projectId={projectId}
      sessionId={sessionId}
      runtimeSessionId={runtimeSessionId}
      onBack={onBack}
    />
  );
}
