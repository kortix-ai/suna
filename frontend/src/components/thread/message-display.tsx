'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Code, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ParsedTag, SUPPORTED_XML_TAGS } from "@/lib/types/tool-calls";
import { getComponentForTag } from "@/components/thread/tool-components";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface MessageDisplayProps {
  content: string;
  role: 'user' | 'assistant';
  isStreaming?: boolean;
}

// Full implementation of XML tag parsing
function parseXMLTags(content: string): { parts: (string | ParsedTag)[], openTags: Record<string, ParsedTag> } {
  const parts: (string | ParsedTag)[] = [];
  const openTags: Record<string, ParsedTag> = {};
  const tagStack: Array<{tagName: string, position: number}> = [];
  
  // Find all opening and closing tags
  let currentPosition = 0;
  
  // Match opening tags with attributes like <tag-name attr="value">
  const openingTagRegex = new RegExp(`<(${SUPPORTED_XML_TAGS.join('|')})\\s*([^>]*)>`, 'g');
  // Match closing tags like </tag-name>
  const closingTagRegex = new RegExp(`</(${SUPPORTED_XML_TAGS.join('|')})>`, 'g');
  
  let match: RegExpExecArray | null;
  let matches: { regex: RegExp, match: RegExpExecArray, isOpening: boolean, position: number }[] = [];
  
  // Find all opening tags
  while ((match = openingTagRegex.exec(content)) !== null) {
    matches.push({ 
      regex: openingTagRegex, 
      match, 
      isOpening: true, 
      position: match.index 
    });
  }
  
  // Find all closing tags
  while ((match = closingTagRegex.exec(content)) !== null) {
    matches.push({ 
      regex: closingTagRegex, 
      match, 
      isOpening: false, 
      position: match.index 
    });
  }
  
  // Sort matches by their position in the content
  matches.sort((a, b) => a.position - b.position);
  
  // Process matches in order
  for (const { match, isOpening, position } of matches) {
    const tagName = match[1];
    const matchEnd = position + match[0].length;
    
    // Add text before this tag if needed
    if (position > currentPosition) {
      parts.push(content.substring(currentPosition, position));
    }
    
    if (isOpening) {
      // Parse attributes for opening tags
      const attributesStr = match[2]?.trim();
      const attributes: Record<string, string> = {};
      
      if (attributesStr) {
        // Match attributes in format: name="value" or name='value'
        const attrRegex = /(\w+)=["']([^"']*)["']/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
          attributes[attrMatch[1]] = attrMatch[2];
        }
      }
      
      // Create tag object with unique ID
      const parsedTag: ParsedTag = {
        tagName,
        attributes,
        content: '',
        isClosing: false,
        id: `${tagName}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        rawMatch: match[0]
      };
      
      // Add timestamp if not present
      if (!parsedTag.timestamp) {
        parsedTag.timestamp = Date.now();
      }
      
      // Push to parts and track in stack
      parts.push(parsedTag);
      tagStack.push({ tagName, position: parts.length - 1 });
      openTags[tagName] = parsedTag;
      
    } else {
      // Handle closing tag
      // Find the corresponding opening tag in the stack (last in, first out)
      let foundOpeningTag = false;
      
      for (let i = tagStack.length - 1; i >= 0; i--) {
        if (tagStack[i].tagName === tagName) {
          const openTagIndex = tagStack[i].position;
          const openTag = parts[openTagIndex] as ParsedTag;
          
          // Get content between this opening and closing tag pair
          let tagContentStart = openTagIndex + 1;
          let tagContentEnd = parts.length;
          
          // Mark that we need to capture content between these positions
          let contentToCapture = '';
          
          // Collect all content parts between the opening and closing tags
          for (let j = tagContentStart; j < tagContentEnd; j++) {
            if (typeof parts[j] === 'string') {
              contentToCapture += parts[j];
            }
          }
          
          // Try getting content directly from original text (most reliable approach)
          const openTagMatch = openTag.rawMatch || '';
          const openTagPosition = content.indexOf(openTagMatch, Math.max(0, openTagIndex > 0 ? currentPosition - 200 : 0));
          if (openTagPosition >= 0) {
            const openTagEndPosition = openTagPosition + openTagMatch.length;
            // Only use if the positions make sense
            if (openTagEndPosition > 0 && position > openTagEndPosition) {
              // Get content and clean up excessive whitespace but preserve formatting
              let extractedContent = content.substring(openTagEndPosition, position);
              
              // Trim leading newline if present
              if (extractedContent.startsWith('\n')) {
                extractedContent = extractedContent.substring(1);
              }
              
              // Trim trailing newline if present
              if (extractedContent.endsWith('\n')) {
                extractedContent = extractedContent.substring(0, extractedContent.length - 1);
              }
              
              contentToCapture = extractedContent;
            }
          }
          
          // Update opening tag with collected content
          openTag.content = contentToCapture;
          openTag.isClosing = true;
          
          // Remove all parts between the opening tag and this position
          // because they're now captured in the tag's content
          if (tagContentStart < tagContentEnd) {
            parts.splice(tagContentStart, tagContentEnd - tagContentStart);
          }
          
          // Remove this tag from the stack
          tagStack.splice(i, 1);
          // Remove from openTags
          delete openTags[tagName];
          
          foundOpeningTag = true;
          break;
        }
      }
      
      // If no corresponding opening tag found, add closing tag as text
      if (!foundOpeningTag) {
        parts.push(match[0]);
      }
    }
    
    currentPosition = matchEnd;
  }
  
  // Add any remaining text
  if (currentPosition < content.length) {
    parts.push(content.substring(currentPosition));
  }
  
  return { parts, openTags };
}

interface MessageContentProps {
  content: string;
  maxHeight?: number;
}

export function MessageContent({ content, maxHeight = 300 }: MessageContentProps) {
  const { parts, openTags } = parseXMLTags(content);
  const [expanded, setExpanded] = useState(false);
  const [showRawXml, setShowRawXml] = useState(false);
  
  const hasXmlTags = parts.some(part => typeof part !== 'string');
  const isLongContent = content.length > 1000 || (parts.length > 0 && parts.some(p => typeof p !== 'string'));
  
  return (
    <div>
      <div 
        className={cn(
          "whitespace-pre-wrap overflow-hidden transition-all duration-200",
          !expanded && isLongContent && "max-h-[300px]"
        )}
        style={{ maxHeight: !expanded && isLongContent ? maxHeight : 'none' }}
      >
        {showRawXml ? (
          <pre className="p-2 bg-muted/30 rounded-md text-xs overflow-x-auto">
            {content}
          </pre>
        ) : (
          <>
            {parts.map((part, index) => {
              if (typeof part === 'string') {
                return (
                  <React.Fragment key={index}>
                    {part.split('\n').map((line, i) => (
                      <React.Fragment key={i}>
                        {line}
                        {i < part.split('\n').length - 1 && <br />}
                      </React.Fragment>
                    ))}
                  </React.Fragment>
                );
              } else {
                const ToolComponent = getComponentForTag(part);
                return (
                  <div 
                    key={index} 
                    className="my-2 rounded-md border border-border/30 overflow-hidden"
                  >
                    <div className="bg-muted/20 px-2 py-1 text-xs font-medium border-b border-border/20 flex items-center justify-between">
                      <span>{part.tagName}</span>
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-transparent">Tool</Badge>
                    </div>
                    <div className="p-2">
                      <ToolComponent key={index} tag={part} mode="compact" />
                    </div>
                  </div>
                );
              }
            })}
          </>
        )}
      </div>
      
      {isLongContent && !expanded && (
        <div className="h-12 bg-gradient-to-t from-background to-transparent -mt-12 relative"></div>
      )}
      
      {(isLongContent || hasXmlTags) && (
        <div className="flex items-center space-x-2 mt-2 text-xs text-muted-foreground">
          {isLongContent && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-5 px-2 text-xs flex items-center gap-1 rounded-md hover:bg-muted/40"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" />
                  Show more
                </>
              )}
            </Button>
          )}
          
          {hasXmlTags && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-5 px-2 text-xs flex items-center gap-1 rounded-md hover:bg-muted/40"
              onClick={() => setShowRawXml(!showRawXml)}
            >
              {showRawXml ? (
                <>
                  <EyeOff className="h-3 w-3" />
                  Hide XML
                </>
              ) : (
                <>
                  <Code className="h-3 w-3" />
                  Show XML
                </>
              )}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageDisplay({ content, role, isStreaming = false }: MessageDisplayProps) {
  return (
    <div className="w-full max-w-screen-lg mb-4 px-4">
      {role === "user" && (
        <div className="text-xs text-muted-foreground mb-1.5 font-medium">You</div>
      )}
      
      {role === "assistant" && (
        <div className="text-xs text-muted-foreground mb-1.5 font-medium">Suna</div>
      )}
      
      <div 
        className={cn(
          "max-w-[90%]",
          role === "user" ? "bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800" : 
                           "bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800",
          "rounded-lg p-3 shadow-sm"
        )}
      >
        <MessageContent content={content} />
        {isStreaming && (
          <span 
            className="inline-block h-4 w-0.5 bg-foreground/50 mx-px"
            style={{ 
              opacity: 0.7,
              animation: 'cursorBlink 1s ease-in-out infinite',
            }}
          />
        )}
        <style jsx global>{`
          @keyframes cursorBlink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}</style>
      </div>
    </div>
  );
}

export function ThinkingIndicator() {
  return (
    <div className="w-full max-w-screen-lg mb-4 px-4">
      <div className="text-xs text-muted-foreground mb-1.5 font-medium">Suna</div>
      
      <div className="max-w-[90%] bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 shadow-sm">
        <div className="flex items-center space-x-1.5">
          <motion.div
            animate={{ scale: [0.8, 1, 0.8] }}
            transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
            className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full"
          />
          <motion.div
            animate={{ scale: [0.8, 1, 0.8] }}
            transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut", delay: 0.2 }}
            className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full"
          />
          <motion.div
            animate={{ scale: [0.8, 1, 0.8] }}
            transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut", delay: 0.4 }}
            className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full"
          />
        </div>
      </div>
    </div>
  );
}

export function EmptyChat({ agentName = "AI assistant" }) {
  return (
    <div className="flex items-center justify-center h-full w-full">
      <div className="text-center px-4">
        <h3 className="text-base font-medium mb-1">What can I help you ship?</h3>
        <p className="text-sm text-muted-foreground max-w-[300px]">
          Send a message to start talking with Suna
        </p>
      </div>
    </div>
  );
} 