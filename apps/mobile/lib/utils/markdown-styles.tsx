/**
 * Markdown Styles Configuration
 * 
 * Comprehensive styling for react-native-markdown-display
 * Ensures perfect rendering of all markdown elements
 * 
 * iOS: Uses native UITextView for proper text selection (via react-native-uitextview)
 * Android/Web: Uses TextInput overlay hack for text selection
 */

import { StyleSheet, Platform, TextInput, Text as RNText, Pressable, Linking, View, UIManager, findNodeHandle } from 'react-native';
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { UITextView } from 'react-native-uitextview';
import * as Clipboard from 'expo-clipboard';

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

// Detect whether any descendant node applies bold styling so the overlay
// TextInput can use a bold weight to better match wrapping where needed.
const hasBoldDeep = (node: any): boolean => {
  if (!node) return false;
  if (Array.isArray(node)) return node.some(hasBoldDeep);
  if (typeof node === 'string' || typeof node === 'number') return false;
  if (React.isValidElement(node)) {
    const props = (node as any).props || {};
    // Check explicit fontWeight style
    const style = props.style || {};
    const fw = style.fontWeight || style.fontweight || style.font || undefined;
    if (fw === 'bold' || fw === '700' || Number(fw) >= 700) return true;
    // Check element type names commonly used for strong/bold in renderers
    const t = (node as any).type;
    if (t === 'strong' || t === 'b' || (typeof t === 'string' && String(t).toLowerCase().includes('strong'))) return true;
    return hasBoldDeep(props.children);
  }
  return false;
};

// Find the maximum font size / line height used in descendants (headings,
// bold, custom styles). We use this to up-scale the overlay TextInput so its
// wrap points match the rendered text when headings or large inline styles
// are present.
const findMaxFontProps = (node: any): { fontSize?: number; lineHeight?: number } => {
  let max: { fontSize?: number; lineHeight?: number } = {};
  const visit = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n === 'string' || typeof n === 'number') return;
    if (React.isValidElement(n)) {
      const props = (n as any).props || {};
      const style = StyleSheet.flatten(props.style) || {};
      if (style.fontSize && (!max.fontSize || style.fontSize > (max.fontSize || 0))) {
        max.fontSize = style.fontSize;
      }
      if (style.lineHeight && (!max.lineHeight || style.lineHeight > (max.lineHeight || 0))) {
        max.lineHeight = style.lineHeight;
      }

      // Detect markdown heading props (some renderers pass `level`)
      const t = (n as any).type;
      const level = props.level;
      if (typeof level === 'number') {
        // Map heading levels to expected font sizes from our styles
        const map: Record<number, number> = { 1: 26, 2: 22, 3: 20, 4: 18, 5: 17, 6: 16 };
        const fs = map[level] || undefined;
        if (fs && (!max.fontSize || fs > (max.fontSize || 0))) max.fontSize = fs;
      }

      visit(props.children);
    }
  };
  visit(node);
  return max;
};

// Helper to render selectable text with clickable links
// iOS: Uses custom markdown renderer with UITextView
// Android/Web: Uses TextInput overlay hack
const SelectableText = ({ children, style, disableSelection, isDark }: any) => {
  // Turn children (React nodes from markdown renderer) into an array we can inspect
  const childArray = React.Children.toArray(children) as any[];

  // Extract raw text for the TextInput value (Android/web only)
  const textContent = extractTextContent(children);

  /**
   * iOS IMPLEMENTATION: Wrap children in selectable UITextView
   * Children are already properly styled UITextView from heading rules
   */
  if (Platform.OS === 'ios') {
    console.log('🔵 iOS SelectableText - wrapping children in selectable UITextView');
    console.log('📦 Children count:', React.Children.count(children));
    console.log('🎨 Style:', JSON.stringify(style));

    // Log the actual children to see what we're rendering
    React.Children.forEach(children, (child: any, index) => {
      if (React.isValidElement(child)) {
        const childType = (child as any).type;
        const typeName = typeof childType === 'function' ? (childType as any).name : childType;
        console.log(`  Child ${index}: type=${typeName}, props=`, Object.keys((child as any).props || {}));
        // Log the props.children to see if there's text deeper down
        const childProps = (child as any).props;
        if (childProps?.children) {
          console.log(`    -> props.children:`, typeof childProps.children === 'string' ? childProps.children : `type=${typeof childProps.children}`);
        }
      } else {
        console.log(`  Child ${index}: plain value=`, typeof child === 'string' ? `"${child}"` : typeof child);
      }
    });

    // Extract text content from children for UITextView
    const textContent = extractTextContent(children);
    console.log('📝 Extracted text content:', textContent);

    // UITextView needs string content, not React components
    // Use the extracted text instead of rendering children
    return (
      <UITextView selectable={true} uiTextView={true} style={style}>
        {textContent}
      </UITextView>
    );
  }

  // LEGACY CODE BELOW - keeping old implementation as fallback
  if (false && Platform.OS === 'ios') {
    // Render AST to styled UITextView components (nested, but NO selectable props on children!)
    const renderNode = (node: any, index: number): any => {
      switch (node.type) {
        case 'text':
          return node.content || '';

        case 'strong':
          return (
            <UITextView key={index} style={{ fontWeight: '700' }}>
              {node.content.map((child: any, i: number) => renderNode(child, i))}
            </UITextView>
          );

        case 'em':
          return (
            <UITextView key={index} style={{ fontStyle: 'italic' }}>
              {node.content.map((child: any, i: number) => renderNode(child, i))}
            </UITextView>
          );

        case 'link':
          return (
            <UITextView
              key={index}
              style={{ color: '#2563eb', textDecorationLine: 'underline' }}
              onPress={() => Linking.openURL(node.target)}
            >
              {node.content.map((child: any, i: number) => renderNode(child, i))}
            </UITextView>
          );

        case 'inlineCode':
          return (
            <UITextView
              key={index}
              style={{
                fontFamily: 'Menlo',
                fontSize: 14,
                backgroundColor: '#f4f4f5',
                color: '#ef4444'
              }}
            >
              {node.content}
            </UITextView>
          );

        case 'heading':
          const level = node.level || 1;
          const headingStyles = {
            1: { fontSize: 26, fontWeight: '700' as const, lineHeight: 34 },
            2: { fontSize: 22, fontWeight: '700' as const, lineHeight: 30 },
            3: { fontSize: 20, fontWeight: '600' as const, lineHeight: 28 },
            4: { fontSize: 18, fontWeight: '600' as const, lineHeight: 26 },
            5: { fontSize: 17, fontWeight: '600' as const, lineHeight: 24 },
            6: { fontSize: 16, fontWeight: '600' as const, lineHeight: 22 },
          };
          const headingStyle = headingStyles[level as keyof typeof headingStyles] || headingStyles[1];
          console.log(`    📰 HEADING DETECTED!`);
          console.log(`       Level: ${level}`);
          console.log(`       Style applied:`, JSON.stringify(headingStyle));
          console.log(`       Content:`, JSON.stringify(node.content));
          const headingResult = (
            <UITextView key={index} style={headingStyle}>
              {node.content.map((child: any, i: number) => renderNode(child, i))}
              {'\n'}
            </UITextView>
          );
          console.log(`       Created UITextView with props:`, JSON.stringify({
            type: headingResult.type.name,
            style: headingResult.props.style,
            childrenCount: React.Children.count(headingResult.props.children)
          }));
          return headingResult;

        case 'paragraph':
          return node.content.map((child: any, i: number) => renderNode(child, i));

        case 'list':
          if (node.items && Array.isArray(node.items)) {
            return node.items.map((item: any, itemIdx: number) => {
              const bullet = node.ordered ? `${itemIdx + 1}. ` : '• ';
              return (
                <UITextView key={`list-${index}-${itemIdx}`}>
                  {bullet}{item.map((child: any, i: number) => renderNode(child, i))}{'\n'}
                </UITextView>
              );
            });
          }
          return null;

        case 'blockQuote':
          return (
            <UITextView key={index} style={{ borderLeftWidth: 4, borderLeftColor: '#71717a', paddingLeft: 8, backgroundColor: '#f4f4f5' }}>
              {node.content.map((child: any, i: number) => renderNode(child, i))}
            </UITextView>
          );

        case 'hr':
          return '\n---\n';

        default:
          if (node.content) {
            if (Array.isArray(node.content)) {
              return node.content.map((child: any, i: number) => renderNode(child, i));
            }
            return renderNode(node.content, index);
          }
          return null;
      }
    };

    // ast is not available in this scope - this legacy code path is disabled
    return (
      <UITextView selectable={true} uiTextView={true} style={style}>
        {textContent}
      </UITextView>
    );
  }

  // Legacy approach (keep as fallback)
  if (false && Platform.OS === 'ios') {
    // Helper: Check if element is a block-level element (should be separate selectable unit)
    const isBlockElement = (node: any): boolean => {
      if (!React.isValidElement(node)) return false;
      const type = (node as any).type;
      const typeString = typeof type === 'function' ? type.name : String(type);

      // Block elements that should be independently selectable
      const blockTypes = [
        'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
        'paragraph', 'blockquote', 'code_block', 'fence',
        'list_item', 'bullet_list_item', 'ordered_list_item',
        'hr', 'table', 'tr'
      ];

      return blockTypes.some(bt => typeString.includes(bt));
    };

    // Helper: Recursively convert React elements to UITextView with proper styling
    const convertToUITextView = (node: any, inheritedStyle: any = {}, depth: number = 0): any => {
      // Base cases: primitives
      if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
      }

      if (node === null || node === undefined) {
        return null;
      }

      // Handle arrays
      if (Array.isArray(node)) {
        return node.map((child, idx) => convertToUITextView(child, inheritedStyle, depth));
      }

      // Must be a React element at this point
      if (!React.isValidElement(node)) {
        return null;
      }

      const props = (node as any).props || {};
      const nodeStyle = StyleSheet.flatten([inheritedStyle, props.style]) || inheritedStyle;
      const children = props.children;

      // Check if this is a block element
      const isBlock = isBlockElement(node);

      // For block elements, wrap in a separate selectable UITextView
      if (isBlock && depth === 0) {
        const convertedChildren = convertToUITextView(children, nodeStyle, depth + 1);

        return (
          <UITextView
            key={props.key || `block-${depth}`}
            style={nodeStyle}
            selectable
            uiTextView
            onPress={props.onPress}
          >
            {convertedChildren}
          </UITextView>
        );
      }

      // For inline elements or nested content, continue recursion
      const convertedChildren = convertToUITextView(children, nodeStyle, depth + 1);

      // If has style or onPress handler, wrap in UITextView
      if (props.style || props.onPress) {
        return (
          <UITextView
            key={props.key}
            style={nodeStyle}
            selectable
            uiTextView
            onPress={props.onPress}
          >
            {convertedChildren}
          </UITextView>
        );
      }

      // Otherwise just return converted children
      return convertedChildren;
    };

    // Check if children is already a block-level structure
    const childArray = React.Children.toArray(children);
    const hasBlockChildren = childArray.some(child => isBlockElement(child));

    // If we have block children, render each as separate selectable unit
    if (hasBlockChildren) {
      return (
        <View>
          {childArray.map((child, idx) => {
            if (isBlockElement(child)) {
              const converted = convertToUITextView(child, style, 0);
              return <View key={idx} style={{ marginBottom: 4 }}>{converted}</View>;
            }
            // Non-block elements (shouldn't happen but handle gracefully)
            return (
              <UITextView key={idx} selectable uiTextView style={style}>
                {convertToUITextView(child, style, 1)}
              </UITextView>
            );
          })}
        </View>
      );
    }

    // Otherwise, single block of selectable text
    const convertedChildren = convertToUITextView(children, style, 1);

    return (
      <UITextView selectable uiTextView style={style}>
        {convertedChildren}
      </UITextView>
    );
  }

  /**
   * ANDROID/WEB IMPLEMENTATION: Keep existing TextInput overlay hack
   */

  // We'll capture layout for any link-like child and store its href and layout
  const [linkLayouts, setLinkLayouts] = useState<Record<number, { x: number; y: number; width: number; height: number; url?: string }>>({});
  const linkMetaRef = useRef<Record<number, string>>({});
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

  // Build background children
  const backgroundChildren = childArray;

  // Parse raw markdown-style links from the extracted text
  const { segments, links: parsedLinks } = parseMarkdownToSegments(textContent);

  // Refs for parsed-segment Text nodes so we can measure absolute window coordinates
  const parsedRefs = useRef<Record<number, any>>({});
  const parsedUrlMap = useRef<Record<number, string | undefined>>({});
  // Container ref and offset so we can convert window coords -> container-local
  const containerRef = useRef<any>(null);
  const containerOffset = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Use the helper functions defined above
  const containsBold = hasBoldDeep(childArray);
  const maxFontProps = findMaxFontProps(childArray);

  // After mount, measure parsedRefs to get absolute positions in window and store layouts
  useEffect(() => {
    const measureContainer = () => {
      const handle = findNodeHandle(containerRef.current);
      if (!handle) return;
      UIManager.measureInWindow(handle, (cx: number, cy: number, cwidth: number, cheight: number) => {
        containerOffset.current = { x: cx, y: cy };
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
    <View style={{ position: 'relative' }} pointerEvents="box-none" ref={containerRef}>
      {/* Hidden mirrored text to measure exact rendered height */}
      {backgroundChildren.length > 0 && (
        <View style={{ position: 'absolute', opacity: 0, left: 0, right: 0 }} pointerEvents="none">
          <RNText
            style={style}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              if (h && h > 0 && measuredHeight !== h) setMeasuredHeight(h);
            }}
          >
            {backgroundChildren}
          </RNText>
        </View>
      )}

      {/* Background visible layer (non-interactive) */}
      <View pointerEvents="none">
        {backgroundChildren.length > 0 ? (
          // If markdown renderer already produced nodes, show them
          <RNText style={style} pointerEvents="none">{backgroundChildren}</RNText>
        ) : (
          // Fallback: render parsed segments and measure link segments
          <RNText style={style} pointerEvents="none">
            {(() => {
              let parsedIdx = 0;
              return segments.map((segment, index) => {
                if (!segment.isLink) {
                  return (
                    <RNText key={`seg-${index}`}>{segment.text}</RNText>
                  );
                }

                const url = parsedLinks && parsedLinks[parsedIdx] ? parsedLinks[parsedIdx].url : undefined;
                const key = `seg-${index}`;
                // assign ref and map so we can measure later
                parsedUrlMap.current[index] = url;
                parsedIdx += 1;

                return (
                  <RNText
                    key={key}
                    ref={(r) => { parsedRefs.current[index] = r; }}
                    style={{ color: '#2563eb', textDecorationLine: 'underline' }}
                  >
                    {segment.text}
                  </RNText>
                );
              });
            })()}
          </RNText>
        )}
      </View>

      {/* Transparent TextInput for selection (Android/web) */}
      {(() => {
        // Flatten incoming style to copy font/spacing props exactly
        const flat = StyleSheet.flatten(style) || {};
        const computedFontSize = maxFontProps.fontSize || flat.fontSize;
        const computedLineHeight = maxFontProps.lineHeight || flat.lineHeight || (computedFontSize ? Math.round(computedFontSize * 1.5) : undefined);

        const fontProps: any = {
          fontFamily: flat.fontFamily,
          fontSize: computedFontSize,
          lineHeight: computedLineHeight,
          fontWeight: containsBold ? (flat.fontWeight ?? '700') : flat.fontWeight,
          letterSpacing: flat.letterSpacing,
          textAlign: flat.textAlign,
        };

        const paddingProps: any = {
          paddingTop: flat.paddingTop ?? flat.padding ?? 0,
          paddingBottom: flat.paddingBottom ?? flat.padding ?? 0,
          paddingLeft: flat.paddingLeft ?? flat.paddingHorizontal ?? flat.padding ?? 0,
          paddingRight: flat.paddingRight ?? flat.paddingHorizontal ?? flat.padding ?? 0,
          marginTop: flat.marginTop ?? 0,
          marginLeft: flat.marginLeft ?? 0,
        };

        return (
          <TextInput
            value={textContent}
            editable={false}
            multiline
            allowFontScaling={flat.allowFontScaling ?? true}
            style={[
              style,
              fontProps,
              paddingProps,
              {
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: measuredHeight ?? undefined,
                backgroundColor: 'transparent',
                color: 'transparent',
                includeFontPadding: false,
                textAlignVertical: 'top',
                paddingBottom: computedLineHeight ? Math.max(2, Math.round(computedLineHeight * 0.15)) : 2,
              }
            ]}
            selectionColor="#3b82f6"
            caretHidden={true}
            showSoftInputOnFocus={false as any}
            textBreakStrategy={'balanced' as any}
          />
        );
      })()}

      {/* Overlays for any link-like children detected */}
      {Object.keys(linkLayouts).map((k) => {
        const idx = Number(k);
        const layout = linkLayouts[idx];
        if (!layout || !layout.url) return null;
        return (
          <Pressable
            key={`press-${idx}`}
            onPress={() => {
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

      {/* Overlays for parsed raw-markdown links (segments) */}
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
                Linking.openURL(url).catch(err => console.error('Failed to open URL:', err));
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
};

// Small helper component that renders a code block with a copy button
const CodeBlockWithCopy = ({ text, style, isDark }: { text: string; style?: any; isDark?: boolean }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
      console.log('📋 Code block copied to clipboard');
    } catch (err) {
      console.error('Failed to copy code block:', err);
    }
  };

  const containerStyle = StyleSheet.flatten([style, { position: 'relative', paddingHorizontal: 12, paddingVertical: 0 }]) || {};

  // Ensure color is present so UITextView doesn't render invisible text
  if (!containerStyle.color) {
    containerStyle.color = isDark ? '#F8F8F8' : '#121215';
  }

  // Add a visible debug border in development to see block bounds
  if (__DEV__) {
    containerStyle.borderWidth = containerStyle.borderWidth ?? 1;
    containerStyle.borderColor = containerStyle.borderColor ?? 'rgba(255,0,0,0.6)';
  }

  useEffect(() => {
    console.log('🔎 CodeBlockWithCopy mounted', {
      platform: Platform.OS,
      textLength: text ? text.length : 0,
      hasText: !!text,
      flattenedStyle: containerStyle,
      isDark,
    });
  }, [text, isDark]);

  return (
    <View style={containerStyle}>
      {Platform.OS === 'ios' ? (
        <UITextView selectable={true} uiTextView={true} style={containerStyle}>
          {text}
        </UITextView>
      ) : (
        <RNText style={containerStyle}>{text}</RNText>
      )}

      <Pressable
        onPress={handleCopy}
        style={{
          position: 'absolute',
          right: 8,
          top: 8,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          paddingHorizontal: 8,
          paddingVertical: 6,
          borderRadius: 8,
        }}
        android_ripple={{ color: 'rgba(0,0,0,0.08)' }}
      >
        <RNText style={{ color: isDark ? '#fff' : '#000', fontSize: 12 }}>{copied ? 'Copied' : 'Copy'}</RNText>
      </Pressable>
    </View>
  );
};

// Render rules to use SelectableText for text content
export const selectableRenderRules = (isDark: boolean = false): any => {
  return {
    // Removed textgroup rule - let default handle it to prevent double wrapping

    paragraph: (node: any, children: any, parent: any, styles: any) => {
      // Wrap paragraphs in SelectableText on iOS
      if (Platform.OS === 'ios') {
        return <SelectableText key={node.key} style={styles.paragraph} isDark={isDark}>{children}</SelectableText>;
      }
      return <RNText key={node.key} style={styles.paragraph}>{children}</RNText>;
    },
    heading1: (node: any, children: any, parent: any, styles: any) => {
      console.log('📰 H1 RULE - wrapping in SelectableText');
      if (Platform.OS === 'ios') {
        return <SelectableText key={node.key} style={styles.heading1} isDark={isDark}>{children}</SelectableText>;
      }
      return <RNText key={node.key} style={styles.heading1}>{children}</RNText>;
    },
    heading2: (node: any, children: any, parent: any, styles: any) => {
      if (Platform.OS === 'ios') {
        return <SelectableText key={node.key} style={styles.heading2} isDark={isDark}>{children}</SelectableText>;
      }
      return <RNText key={node.key} style={styles.heading2}>{children}</RNText>;
    },
    heading3: (node: any, children: any, parent: any, styles: any) => {
      if (Platform.OS === 'ios') {
        return <SelectableText key={node.key} style={styles.heading3} isDark={isDark}>{children}</SelectableText>;
      }
      return <RNText key={node.key} style={styles.heading3}>{children}</RNText>;
    },
    // Inline code renderer - must be defined to prevent React Native from trying to render HTML <code> tags
    code_inline: (node: any, children: any, parent: any, styles: any) => {
      // Extract text content from node or children
      const text = node.content || extractTextContent(children) || '';
      if (Platform.OS === 'ios') {
        return <SelectableText key={node.key} style={styles.code_inline} isDark={isDark}>{text}</SelectableText>;
      }
      return <RNText key={node.key} style={styles.code_inline}>{text}</RNText>;
    },
    // Code blocks with copy button
    code_block: (node: any, children: any, parent: any, styles: any) => {
      // For code blocks, the markdown parser puts the actual code in node.content, not children
      const text = node.content || '';
      return <CodeBlockWithCopy key={node.key} text={text} style={styles.code_block} isDark={isDark} />;
    },
    fence: (node: any, children: any, parent: any, styles: any) => {
      // For fenced code blocks, the markdown parser puts the actual code in node.content, not children
      const text = node.content || '';
      return <CodeBlockWithCopy key={node.key} text={text} style={styles.fence} isDark={isDark} />;
    },
    heading4: (node: any, children: any, parent: any, styles: any) => {
      if (Platform.OS === 'ios') {
        return <SelectableText key={node.key} style={styles.heading4} isDark={isDark}>{children}</SelectableText>;
      }
      return <RNText key={node.key} style={styles.heading4}>{children}</RNText>;
    },
    heading5: (node: any, children: any, parent: any, styles: any) => {
      if (Platform.OS === 'ios') {
        return <SelectableText key={node.key} style={styles.heading5} isDark={isDark}>{children}</SelectableText>;
      }
      return <RNText key={node.key} style={styles.heading5}>{children}</RNText>;
    },
    heading6: (node: any, children: any, parent: any, styles: any) => {
      if (Platform.OS === 'ios') {
        return <SelectableText key={node.key} style={styles.heading6} isDark={isDark}>{children}</SelectableText>;
      }
      return <RNText key={node.key} style={styles.heading6}>{children}</RNText>;
    },
  };
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
  },

  // Lists
  bullet_list: {},
  ordered_list: {},
  list_item: {
    flexDirection: 'row',
    // Align items to the top so bullets align with the first line of text
    alignItems: 'flex-start',
  },
  bullet_list_icon: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#71717a', // zinc-500
    // Slight top offset so the small bullet vertically centers with text
    marginTop: 8,
    marginRight: 10,
    marginLeft: 0,
  },
  ordered_list_icon: {
    minWidth: 22,
    marginTop: 6,
    marginRight: 10,
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
    backgroundColor: '#DCDDDE80', // border color (light mode)
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DCDDDE', // border
    color: '#121215', // primary (black text)
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 16,
  },
  fence: {
    backgroundColor: '#DCDDDE', // border color (light mode)
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DCDDDE', // border
    color: '#121215', // primary (black text)
    fontFamily: 'Menlo, Monaco, Courier New, monospace',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 16,
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
    // Remove negative margin which caused links (esp. in lists)
    // to appear vertically misaligned with bullets.
    marginTop: 0,
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
    backgroundColor: '#232324', // border color (dark mode)
    borderColor: '#232324', // border
    color: '#F8F8F8', // primary (white text)
  },

  fence: {
    ...markdownStyles.fence,
    backgroundColor: '#232324', // border color (dark mode)
    borderColor: '#232324', // border
    color: '#F8F8F8', // primary (white text)
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
    color: '#fafafa', // zinc-50 - light text for dark mode
  },

  tr: {
    ...markdownStyles.tr,
    borderBottomColor: '#3f3f46', // zinc-700
  },

  td: {
    ...markdownStyles.td,
    borderRightColor: '#3f3f46', // zinc-700
    color: '#fafafa', // zinc-50 - light text for dark mode
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

  // Paragraph and text must be light in dark mode
  paragraph: {
    ...markdownStyles.paragraph,
    color: '#fafafa', // zinc-50 - light text for dark mode
  },

  text: {
    ...markdownStyles.text,
    color: '#fafafa', // zinc-50 - light text for dark mode
  },

  // List items also need light text
  list_item: {
    ...markdownStyles.list_item,
    color: '#fafafa', // zinc-50 - light text for dark mode
  },

  bullet_list_content: {
    ...markdownStyles.bullet_list_content,
    color: '#fafafa', // zinc-50 - light text for dark mode
  },

  ordered_list_content: {
    ...markdownStyles.ordered_list_content,
    color: '#fafafa', // zinc-50 - light text for dark mode
  },
});

