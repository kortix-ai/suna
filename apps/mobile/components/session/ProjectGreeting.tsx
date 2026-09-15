/**
 * ProjectGreeting — the Kortix symbol over one fixed sentence:
 * "Give {project name} something real to work on."
 *
 * The one hero for an empty project surface. ProjectHome (no chat open) and
 * SessionPage's FreshSessionHero (a new chat with no messages) both render it,
 * so the two states cannot drift apart. Web parity: `ProjectHomeWelcomeBody`
 * shares one heading between the project index and the instant session shell.
 *
 * The name is the only foreground word; the rest of the sentence is muted.
 * Both spans carry `variant="lead"` because a nested `Text` restates the base
 * `text-base` size and would otherwise shrink the name.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { Text } from '@/components/ui/text';
import { KortixLogo } from '@/components/kortix/KortixLogo';
import { PROJECT_GREETING, projectGreetingName } from '@/lib/session/project-greeting';

export function ProjectGreeting({ projectName }: { projectName?: string | null }) {
  const { colorScheme } = useColorScheme();

  return (
    <View className="items-center gap-4">
      <KortixLogo size={38} color={colorScheme === 'dark' ? 'dark' : 'light'} />
      <Text variant="lead" role="heading" className="text-center">
        {PROJECT_GREETING.before}{' '}
        <Text variant="lead" className="text-foreground">
          {projectGreetingName(projectName)}
        </Text>{' '}
        {PROJECT_GREETING.after}
      </Text>
    </View>
  );
}
