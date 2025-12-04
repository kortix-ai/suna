/**
 * Markdown Styles Configuration
 * 
 * Comprehensive styling for react-native-markdown-display
 * Ensures perfect rendering of all markdown elements
 */

import { StyleSheet, Platform, TextInput, Text, Pressable, Linking, View, UIManager, findNodeHandle } from 'react-native';
import React, { useState, useRef, useCallback, useEffect } from 'react';

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

// Parse markdown links and extract positions
const parseMarkdownLinks = (text: string): { text: string; url: string; start: number; end: number }[] => {
  const linkRegex = /\[([^\]]+)\]\(([^\)]+)\)/g;
  const links: { text: string; url: string; start: number; end: number }[] = [];
  let match;

  while ((match = linkRegex.exec(text)) !== null) {
    links.push({
      text: match[1],
      url: match[2],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return links;
};

// Convert markdown to segments with link info
const parseMarkdownToSegments = (markdown: string): { segments: { text: string; isLink: boolean; url?: string }[]; links: { text: string; url: string; plainStart: number; plainEnd: number }[] } => {
  const linkRegex = /\[([^\]]+)\]\(([^\)]+)\)/g;
  const segments: { text: string; isLink: boolean; url?: string }[] = [];
  const links: { text: string; url: string; plainStart: number; plainEnd: number }[] = [];
  let lastIndex = 0;
  let plainTextPosition = 0;
  let match;

  while ((match = linkRegex.exec(markdown)) !== null) {
    // Add text before link
    if (match.index > lastIndex) {
      const textBefore = markdown.substring(lastIndex, match.index);
      segments.push({ text: textBefore, isLink: false });
      plainTextPosition += textBefore.length;
    }

    // Add link
    const linkText = match[1];
    const linkUrl = match[2];
    segments.push({ text: linkText, isLink: true, url: linkUrl });

    links.push({
      text: linkText,
      url: linkUrl,
      plainStart: plainTextPosition,
      plainEnd: plainTextPosition + linkText.length,
    });

    plainTextPosition += linkText.length;
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < markdown.length) {
    segments.push({ text: markdown.substring(lastIndex), isLink: false });
  }

  return { segments, links };
};

// Helper to render selectable text with clickable links
const SelectableText = ({ children, style, disableSelection }: any) => {
  // Turn children (React nodes from markdown renderer) into an array we can inspect
  const childArray = React.Children.toArray(children) as any[];

  // Extract raw text for the TextInput value
  const textContent = extractTextContent(children);
  // Log full extracted text for debugging (trim long strings)
  console.log('SelectableText: extractedText:', textContent.length > 300 ? textContent.substring(0, 300) + '...' : textContent);

  // We'll capture layout for any link-like child and store its href and layout
  const [linkLayouts, setLinkLayouts] = useState<Record<number, { x: number; y: number; width: number; height: number; url?: string }>>({});
  const linkMetaRef = useRef<Record<number, string>>({});

  // Deep check for interactive links (onPress or href)
  const hasInteractiveLinkDeep = (node: any): boolean => {
    if (!node) return false;
    if (React.isValidElement(node)) {
      const props = node.props as any;
      if (props?.onPress || props?.href || props?.attributes?.href) {
        return true;
      }
      const children = props?.children;
      if (Array.isArray(children)) {
        return children.some(hasInteractiveLinkDeep);
      }
      if (React.isValidElement(children)) {
        return hasInteractiveLinkDeep(children);
      }
    }
    return false;
  };

  const hasInteractiveLinks = childArray.some(hasInteractiveLinkDeep);
  console.log('SelectableText: hasInteractiveLinks =', hasInteractiveLinks);

  // Build background children (not needed if we have interactive links)
  const backgroundChildren = childArray;

  // Additionally parse raw markdown-style links from the extracted text (covers cases where
  // the markdown renderer left raw text like `[GitHub](https://...)`). We use parseMarkdownToSegments
  // to detect those and compute overlay positions by rendering the plain text behind.
  const { segments, links: parsedLinks } = parseMarkdownToSegments(textContent);

  // Refs for parsed-segment Text nodes so we can measure absolute window coordinates
  const parsedRefs = useRef<Record<number, any>>({});
  const parsedUrlMap = useRef<Record<number, string | undefined>>({});
  // Container ref and offset so we can convert window coords -> container-local
  const containerRef = useRef<any>(null);
  const containerOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Log children details with deeper inspection
  console.log('SelectableText children details:');
  childArray.forEach((child, idx) => {
    if (React.isValidElement(child)) {
      const childProps = child.props as any;
      const childType = child.type as any;
      console.log(`  child[${idx}]:`, {
        type: childType?.name || child.type,
        props: Object.keys(child.props || {}),
        hasOnPress: !!childProps?.onPress,
        hasHref: !!(childProps?.href || childProps?.attributes?.href),
        href: childProps?.href || childProps?.attributes?.href,
        children: typeof childProps?.children === 'string' ? childProps.children : 'complex',
        allProps: child.props,
      });
    } else {
      console.log(`  child[${idx}]: text =`, String(child).substring(0, 50));
    }
  });

  console.log('SelectableText debug:', {
    childCount: childArray.length,
    backgroundChildrenCount: backgroundChildren.length,
    linkMeta: linkMetaRef.current,
    segmentsCount: segments.length,
    parsedLinks: parsedLinks,
    linkLayoutsCount: Object.keys(linkLayouts).length,
  });

  if (Platform.OS === 'ios') {
    // If markdown renderer already made interactive links with onPress, just render them normally
    // The onPress handlers will work and links are already blue - NO TextInput overlay
    if (hasInteractiveLinks) {
      return <Text style={style}>{children}</Text>;
    }

    // After mount, measure parsedRefs to get absolute positions in window and store layouts
    useEffect(() => {
      const measureContainer = () => {
        const handle = findNodeHandle(containerRef.current);
        if (!handle) return;
        UIManager.measureInWindow(handle, (cx: number, cy: number, cwidth: number, cheight: number) => {
          containerOffset.current = { x: cx, y: cy };
          console.log('SelectableText: container offset:', containerOffset.current);
        });
      };

      const keys = Object.keys(parsedRefs.current);
      const measureAll = () => {
        keys.forEach(k => {
          const idx = Number(k);
          const node = parsedRefs.current[idx];
          if (!node) return;
          const handle = findNodeHandle(node);
          if (!handle) return;
          // measureInWindow gives absolute window coordinates
          UIManager.measureInWindow(handle, (x: number, y: number, width: number, height: number) => {
            const url = parsedUrlMap.current[idx];
            // convert to container-local
            const localX = x - containerOffset.current.x;
            const localY = y - containerOffset.current.y;
            console.log('SelectableText: measureInWindow idx=', idx, 'url=', url, 'window=', { x, y, width, height }, 'local=', { x: localX, y: localY, width, height });
            setLinkLayouts(prev => ({ ...prev, [idx]: { x: localX, y: localY, width, height, url } }));
          });
        });
      };

      // Defer to next frame to ensure layout finished
      requestAnimationFrame(() => {
        measureContainer();
        measureAll();
      });
    }, [textContent]);

    return (
      <View style={{ position: 'relative' }} pointerEvents="box-none">
        {/* Background visible layer (non-interactive) */}
        <View pointerEvents="none">
          {backgroundChildren.length > 0 ? (
            // If markdown renderer already produced nodes, show them
            <Text style={style} pointerEvents="none">{backgroundChildren}</Text>
          ) : (
            // Fallback: render parsed segments and measure link segments
            <Text style={style} pointerEvents="none">
              {(() => {
                let parsedIdx = 0;
                return segments.map((segment, index) => {
                  if (!segment.isLink) {
                    return (
                      <Text key={`seg-${index}`}>{segment.text}</Text>
                    );
                  }

                  const url = parsedLinks && parsedLinks[parsedIdx] ? parsedLinks[parsedIdx].url : undefined;
                  const key = `seg-${index}`;
                  // assign ref and map so we can measure later
                  parsedUrlMap.current[index] = url;
                  parsedIdx += 1;

                  return (
                    <Text
                      key={key}
                      ref={(r) => { parsedRefs.current[index] = r; }}
                      style={{ color: '#2563eb', textDecorationLine: 'underline' }}
                    >
                      {segment.text}
                    </Text>
                  );
                });
              })()}
            </Text>
          )}
        </View>

        {/* Transparent TextInput for selection */}
        <TextInput
          value={textContent}
          editable={false}
          multiline
          style={[
            style,
            {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              backgroundColor: 'transparent',
              color: 'transparent',
            }
          ]}
        />

        {/* Overlays for any link-like children detected */}
        {Object.keys(linkLayouts).map((k) => {
          const idx = Number(k);
          const layout = linkLayouts[idx];
          if (!layout || !layout.url) return null;
          console.log(`SelectableText: rendering overlay for idx=${idx} url=${layout.url} layout=`, layout);
          return (
            <Pressable
              key={`press-${idx}`}
              onPress={() => {
                console.log('SelectableText: overlay pressed idx=', idx, 'url=', layout.url);
                Linking.openURL(layout.url!).catch(err => console.error('Failed to open URL:', err));
              }}
              android_ripple={{ color: 'transparent' }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              pointerEvents="auto"
              style={{
                position: 'absolute',
                left: layout.x,
                top: layout.y,
                width: Math.max(layout.width, 8),
                height: Math.max(layout.height, 8),
                zIndex: 9999,
                elevation: 9999,
                backgroundColor: 'transparent',
              }}
            />
          );
        })}

        {/* Overlays for parsed raw-markdown links (segments). These only render if we used the
            fallback segments rendering above (no renderer nodes). */}
        {backgroundChildren.length === 0 && segments.map((segment, idx) => {
          if (!segment.isLink) return null;
          const layout = linkLayouts[idx];
          if (!layout) return null;
          return (
            <Pressable
              key={`seg-press-${idx}`}
              onPress={() => {
                const url = parsedUrlMap.current[idx] || (parseMarkdownLinks(textContent).find(l => l.text === segment.text)?.url);
                if (url) {
                  console.log('SelectableText: parsed-seg overlay pressed idx=', idx, 'url=', url);
                  Linking.openURL(url).catch(err => console.error('Failed to open URL:', err));
                } else {
                  console.log('SelectableText: parsed-seg overlay pressed idx=', idx, 'but no url found');
                }
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              pointerEvents="auto"
              style={{
                position: 'absolute',
                left: layout.x,
                top: layout.y,
                width: Math.max(layout.width, 8),
                height: Math.max(layout.height, 8),
                zIndex: 9999,
                elevation: 9999,
                backgroundColor: 'transparent',
              }}
            />
          );
        })}
      </View>
    );
  }

  // Android: simple selectable Text
  return (
    <Text selectable style={style}>{children}</Text>
  );
};

// Render rules to use SelectableText for text content
export const selectableRenderRules: any = {
  textgroup: (node: any, children: any, parent: any, styles: any) => {
    return <SelectableText key={node.key} style={styles.text}>{children}</SelectableText>;
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
    lineHeight: 34,
    color: '#18181b',
  },
  heading2: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 30,
    color: '#18181b',
  },
  heading3: {
    fontSize: 20,
    fontWeight: '600',
    lineHeight: 28,
    color: '#18181b',
  },
  heading4: {
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 26,
    color: '#18181b',
  },
  heading5: {
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 24,
    color: '#18181b',
  },
  heading6: {
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 22,
    color: '#18181b',
  },

  // Horizontal rule
  hr: {
    backgroundColor: '#e4e4e7', // zinc-200
    height: 1,
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
  },

  // Lists
  bullet_list: {},
  ordered_list: {},
  list_item: {
    flexDirection: 'row',
  },
  bullet_list_icon: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#71717a', // zinc-500
  },
  ordered_list_icon: {
    minWidth: 22,
  },
  bullet_list_content: {
    flex: 1,
  },
  ordered_list_content: {
    flex: 1,
  },

  // Code
  code_inline: {
    backgroundColor: '#f4f4f5', // zinc-100
    borderWidth: 1,
    borderColor: '#e4e4e7', // zinc-200
    borderRadius: 4,
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    color: '#dc2626', // red-600
  },
  code_block: {
    backgroundColor: '#18181b', // zinc-900
    borderRadius: 8,
    color: '#fafafa', // zinc-50 - LIGHT TEXT FOR DARK BACKGROUND
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    lineHeight: 20,
  },
  fence: {
    backgroundColor: '#18181b', // zinc-900
    borderRadius: 8,
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
  },
  thead: {
    backgroundColor: '#f4f4f5', // zinc-100
  },
  tbody: {},
  th: {
    flex: 1,
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
    borderRightWidth: 1,
    borderRightColor: '#e4e4e7', // zinc-200
  },

  // Links
  link: {
    color: '#2563eb', // blue-600 - more prominent
    textDecorationLine: 'underline',
    fontWeight: '500', // slightly bolder
    fontSize: 16,
    lineHeight: 24,
    marginTop: -8,
  },      // Images
  image: {
    maxWidth: '100%',
    height: 200,
    borderRadius: 8,
  },

  // Paragraphs
  paragraph: {
    lineHeight: 24,
    fontSize: 16,
  },

  // Base text
  text: {
    fontSize: 16,
    lineHeight: 24,
  },

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

