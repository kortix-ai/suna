/**
 * Custom Markdown Rendering Rules
 * 
 * These rules make text selectable in markdown rendered content
 */

import React from 'react';
import { Text } from 'react-native';

export const markdownRules = {
  textgroup: (node: any, children: any, parent: any, styles: any) => {
    return (
      <Text key={node.key} selectable>
        {children}
      </Text>
    );
  },
};












