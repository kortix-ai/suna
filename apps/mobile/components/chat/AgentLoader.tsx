import * as React from 'react';
import { View } from 'react-native';
import { KortixLoader } from '@/components/ui';

/**
 * AgentLoader - Shows the Kortix animated logo while the agent is processing
 * 
 * Used as the initial loading state before response content starts appearing.
 * The animation loops continuously until replaced by actual content.
 */
export const AgentLoader = React.memo(function AgentLoader() {
  return (
    <View className="flex-row items-center py-4">
      <KortixLoader size="small" />
    </View>
  );
});

export default AgentLoader;
