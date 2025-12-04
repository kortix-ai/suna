/**
 * Markdown Styles Configuration
 * 
 * Comprehensive styling for react-native-markdown-display
 * Ensures perfect rendering of all markdown elements
 */

import { StyleSheet, Platform, TextInput, Text } from 'react-native';
import React from 'react';

// Helper to extract text content from children (including nested React elements)
const extractTextContent = (children: any): string => {
  if (typeof children === 'string') {
    return children;
  }

  if (typeof children === 'number') {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map(extractTextContent).join('');
  }

  if (React.isValidElement(children)) {
    // If it's a React element, try to extract text from its children
    return extractTextContent((children as any).props?.children);
  }

  if (children === null || children === undefined) {
    return '';
  }

  // Fallback for objects - should rarely happen
  return '';
};

// Helper to render selectable text with iOS workaround
const SelectableText = ({ children, style }: any) => {
  if (Platform.OS === 'ios') {
    // iOS requires TextInput for word selections with blue handles
    const textContent = extractTextContent(children);

    return (
      <TextInput
        value={textContent}
        editable={false}
        multiline
        scrollEnabled={false}
        style={[
          style,
          {
            // Adjust for iOS TextInput internal padding
            paddingTop: 12, // Add padding to restore height
            paddingBottom: 12,
            paddingLeft: 0,
            paddingRight: 0,
            paddingHorizontal: 0,
            margin: 0,
            marginTop: -8, // Counteract iOS TextInput internal padding
            marginBottom: 0,
            borderWidth: 0,
            outlineStyle: 'none',
            // Ensure text aligns properly
            textAlignVertical: 'top',
          }
        ]}
      />
    );
  }

  // Android can do word selections just with <Text>
  return <Text selectable style={style}>{children}</Text>;
};

// Custom render rules for selectable text
export const selectableRenderRules: any = {
  text: (node: any, children: any, parent: any, styles: any, inheritedStyles: any = {}) => (
    <SelectableText key={node.key} style={[inheritedStyles, styles.text]}>
      {node.content}
    </SelectableText>
  ),
  textgroup: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.textgroup}>
      {children}
    </SelectableText>
  ),
  paragraph: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.paragraph}>
      {children}
    </SelectableText>
  ),
  strong: (node: any, children: any, parent: any, styles: any, inheritedStyles: any = {}) => (
    <SelectableText key={node.key} style={[inheritedStyles, styles.strong]}>
      {children}
    </SelectableText>
  ),
  em: (node: any, children: any, parent: any, styles: any, inheritedStyles: any = {}) => (
    <SelectableText key={node.key} style={[inheritedStyles, styles.em]}>
      {children}
    </SelectableText>
  ),
  code_inline: (node: any, children: any, parent: any, styles: any, inheritedStyles: any = {}) => (
    <SelectableText key={node.key} style={[inheritedStyles, styles.code_inline]}>
      {children}
    </SelectableText>
  ),
  heading1: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.heading1}>
      {children}
    </SelectableText>
  ),
  heading2: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.heading2}>
      {children}
    </SelectableText>
  ),
  heading3: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.heading3}>
      {children}
    </SelectableText>
  ),
  heading4: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.heading4}>
      {children}
    </SelectableText>
  ),
  heading5: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.heading5}>
      {children}
    </SelectableText>
  ),
  heading6: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.heading6}>
      {children}
    </SelectableText>
  ),
  blockquote: (node: any, children: any, parent: any, styles: any) => (
    <SelectableText key={node.key} style={styles.blockquote}>
      {children}
    </SelectableText>
  ),
  link: (node: any, children: any, parent: any, styles: any, onLinkPress: any) => {
    return (
      <SelectableText
        key={node.key}
        style={styles.link}
        onPress={() => onLinkPress && onLinkPress(node.attributes.href)}
      >
        {children}
      </SelectableText>
    );
  },
};

export const markdownStyles = StyleSheet.create({
  // Root body
  body: {
    color: '#18181b', // zinc-900
    fontSize: 16,
    lineHeight: 24,
    fontFamily: 'System',
  },

  // Headings
  heading1: {
    fontSize: 26,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
    lineHeight: 34,
    color: '#18181b',
  },
  heading2: {
    fontSize: 22,
    fontWeight: '700',
    marginTop: 14,
    marginBottom: 6,
    lineHeight: 30,
    color: '#18181b',
  },
  heading3: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
    lineHeight: 28,
    color: '#18181b',
  },
  heading4: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 10,
    marginBottom: 4,
    lineHeight: 26,
    color: '#18181b',
  },
  heading5: {
    fontSize: 17,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 4,
    lineHeight: 24,
    color: '#18181b',
  },
  heading6: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 4,
    lineHeight: 22,
    color: '#18181b',
  },

  // Horizontal rule
  hr: {
    backgroundColor: '#e4e4e7', // zinc-200
    height: 1,
    marginVertical: 12,
  },

  // Emphasis
  strong: {
    fontWeight: '700',
  },
  em: {
    fontStyle: 'italic',
  },
  s: {
    textDecorationLine: 'line-through',
  },

  // Blockquote
  blockquote: {
    backgroundColor: '#f4f4f5', // zinc-100
    borderLeftColor: '#71717a', // zinc-500
    borderLeftWidth: 4,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  // Lists
  bullet_list: {
    marginVertical: 4,
  },
  ordered_list: {
    marginVertical: 4,
  },
  list_item: {
    flexDirection: 'row',
    marginVertical: 3,
  },
  bullet_list_icon: {
    marginLeft: 0,
    marginRight: 10,
    marginTop: 8,
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#71717a', // zinc-500
  },
  ordered_list_icon: {
    marginLeft: 0,
    marginRight: 10,
    minWidth: 22,
  },
  bullet_list_content: {
    flex: 1,
    marginTop: 0,
  },
  ordered_list_content: {
    flex: 1,
    marginTop: 0,
  },

  // Code
  code_inline: {
    backgroundColor: '#f4f4f5', // zinc-100
    borderWidth: 1,
    borderColor: '#e4e4e7', // zinc-200
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    color: '#dc2626', // red-600
  },
  code_block: {
    backgroundColor: '#18181b', // zinc-900
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    color: '#fafafa', // zinc-50 - LIGHT TEXT FOR DARK BACKGROUND
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    lineHeight: 20,
  },
  fence: {
    backgroundColor: '#18181b', // zinc-900
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    color: '#fafafa', // zinc-50 - LIGHT TEXT FOR DARK BACKGROUND
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    lineHeight: 20,
  },

  // Tables
  table: {
    borderWidth: 1,
    borderColor: '#e4e4e7', // zinc-200
    borderRadius: 6,
    marginVertical: 8,
  },
  thead: {
    backgroundColor: '#f4f4f5', // zinc-100
  },
  tbody: {},
  th: {
    flex: 1,
    padding: 8,
    borderBottomWidth: 2,
    borderBottomColor: '#d4d4d8', // zinc-300
    borderRightWidth: 1,
    borderRightColor: '#e4e4e7', // zinc-200
    fontWeight: '600',
  },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e4e4e7', // zinc-200
  },
  td: {
    flex: 1,
    padding: 8,
    borderRightWidth: 1,
    borderRightColor: '#e4e4e7', // zinc-200
  },

  // Links
  link: {
    color: '#2563eb', // blue-600 - more prominent
    textDecorationLine: 'underline',
    fontWeight: '500', // slightly bolder
  },

  // Images
  image: {
    maxWidth: '100%',
    height: 200,
    borderRadius: 8,
    marginVertical: 8,
  },

  // Paragraphs
  paragraph: {
    marginVertical: 6,
    lineHeight: 24,
    fontSize: 16,
  },

  // Base text
  text: {
    fontSize: 16,
    lineHeight: 24,
  },

  // Text container CAUSES MISSCENTERIN OF TEXT
  // textgroup: {
  //   marginBottom: 4,
  // },

  // Delete
  del: {
    textDecorationLine: 'line-through',
    textDecorationStyle: 'solid',
  },
});

/**
 * Dark mode markdown styles
 */
export const markdownStylesDark = StyleSheet.create({
  ...markdownStyles,
  body: {
    ...markdownStyles.body,
    color: '#fafafa', // zinc-50
  },

  heading1: {
    ...markdownStyles.heading1,
    color: '#fafafa',
  },
  heading2: {
    ...markdownStyles.heading2,
    color: '#fafafa',
  },
  heading3: {
    ...markdownStyles.heading3,
    color: '#fafafa',
  },
  heading4: {
    ...markdownStyles.heading4,
    color: '#fafafa',
  },
  heading5: {
    ...markdownStyles.heading5,
    color: '#fafafa',
  },
  heading6: {
    ...markdownStyles.heading6,
    color: '#fafafa',
  },

  hr: {
    ...markdownStyles.hr,
    backgroundColor: '#3f3f46', // zinc-700
  },

  blockquote: {
    ...markdownStyles.blockquote,
    backgroundColor: '#27272a', // zinc-800
    borderLeftColor: '#a1a1aa', // zinc-400
  },

  code_inline: {
    ...markdownStyles.code_inline,
    backgroundColor: '#27272a', // zinc-800
    borderColor: '#3f3f46', // zinc-700
    color: '#fca5a5', // red-300
  },

  code_block: {
    ...markdownStyles.code_block,
    backgroundColor: '#09090b', // zinc-950
    color: '#fafafa', // zinc-50 - KEEP LIGHT TEXT
  },

  fence: {
    ...markdownStyles.fence,
    backgroundColor: '#09090b', // zinc-950
    color: '#fafafa', // zinc-50 - KEEP LIGHT TEXT
  },

  table: {
    ...markdownStyles.table,
    borderColor: '#3f3f46', // zinc-700
  },

  thead: {
    ...markdownStyles.thead,
    backgroundColor: '#27272a', // zinc-800
  },

  th: {
    ...markdownStyles.th,
    borderBottomColor: '#52525b', // zinc-600
    borderRightColor: '#3f3f46', // zinc-700
  },

  tr: {
    ...markdownStyles.tr,
    borderBottomColor: '#3f3f46', // zinc-700
  },

  td: {
    ...markdownStyles.td,
    borderRightColor: '#3f3f46', // zinc-700
  },

  link: {
    ...markdownStyles.link,
    color: '#3b82f6', // blue-500 - bright for dark mode
  },

  bullet_list_icon: {
    marginLeft: 0,
    marginRight: 10,
    marginTop: 8,
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#a1a1aa', // zinc-400
  },
});

