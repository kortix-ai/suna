'use client';

import React, { useState } from 'react';
import { Maximize2, Terminal, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ParsedTag, SUPPORTED_XML_TAGS } from "@/lib/types/tool-calls";
import { motion } from "motion/react";
import Image from "next/image";
import { useTheme } from "next-themes";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface MessageDisplayProps {
  content: string;
  role: 'user' | 'assistant' | 'tool';
  isStreaming?: boolean;
  showIdentifier?: boolean;
  isPartOfChain?: boolean;
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
  role: 'user' | 'assistant' | 'tool';
  isPartOfChain?: boolean;
}

function ToolHeader({ icon: Icon, label }: { icon: any, label: string }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

function CodeBlock({ content, filename }: { content: string, filename?: string }) {
  return (
    <div className="font-mono text-sm">
      {filename && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-border/30 bg-background/50 rounded-t-xl">
          <span className="text-xs text-muted-foreground font-medium">{filename}</span>
          <div className="flex gap-1.5">
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted/30 font-medium">Diff</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted/30 font-medium">Original</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">Modified</span>
          </div>
        </div>
      )}
      <div className="p-4 bg-muted/[0.02] rounded-b-xl">
        <pre className="whitespace-pre-wrap text-[13px] leading-relaxed">{content}</pre>
      </div>
    </div>
  );
}

export function MessageContent({ content, maxHeight = 300, role, isPartOfChain }: MessageContentProps) {
  const { parts } = parseXMLTags(content);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isTool = role === 'tool';
  
  return (
    <>
      <div className={cn(
        "w-full",
        isPartOfChain && "pl-6 border-l border-border/20"
      )}>
        <div className={cn(
          "w-full overflow-hidden rounded-xl border border-border/40 bg-background/50 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)]",
          isTool && "font-mono text-[13px]"
        )}>
          {parts.map((part, index) => {
            if (typeof part === 'string') {
              return (
                <div key={index} className="p-4">
                  {part.split('\n').map((line, i) => (
                    <React.Fragment key={i}>
                      <span className="leading-relaxed">{line}</span>
                      {i < part.split('\n').length - 1 && <br />}
                    </React.Fragment>
                  ))}
                </div>
              );
            } else {
              const isCreateFile = part.tagName === 'create-file';
              const isExecuteCommand = part.tagName === 'execute-command';
              
              return (
                <div key={index}>
                  <div className="px-4 py-2 border-b border-border/30">
                    {isCreateFile && (
                      <ToolHeader 
                        icon={FileText} 
                        label={`Creating file ${part.attributes.file_path || ''}`} 
                      />
                    )}
                    {isExecuteCommand && (
                      <ToolHeader 
                        icon={Terminal} 
                        label="Executing command" 
                      />
                    )}
                    {!isCreateFile && !isExecuteCommand && (
                      <ToolHeader 
                        icon={Terminal} 
                        label={part.tagName} 
                      />
                    )}
                  </div>
                  
                  <CodeBlock 
                    content={part.content}
                    filename={isCreateFile ? part.attributes.file_path : undefined}
                  />
                </div>
              );
            }
          })}
        </div>
      </div>

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="right" className="w-[600px] sm:w-[800px] bg-background">
          <SheetHeader>
            <SheetTitle className="text-left">
              {isTool ? 'Command Output' : 'Message Content'}
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4 overflow-y-auto max-h-[calc(100vh-8rem)] px-2">
            <CodeBlock content={content} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export function MessageDisplay({ content, role, isStreaming = false, showIdentifier = false, isPartOfChain = false }: MessageDisplayProps) {
  const isUser = role === 'user';
  const { theme } = useTheme();

  return (
    <motion.div 
      className={cn(
        "w-full px-4 py-3 flex flex-col",
        isUser ? "bg-transparent" : "bg-muted/[0.03]",
        isStreaming && "animate-pulse",
        isPartOfChain && "pt-0"
      )}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
    >
      <div className="w-full max-w-5xl mx-auto relative">
        {!isUser && showIdentifier && (
          <motion.div 
            className="flex items-center gap-2 mb-2"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: 0.1 }}
          >
            <div className="flex items-center bg-background rounded-full size-8 flex-shrink-0 justify-center shadow-[0_0_10px_rgba(0,0,0,0.05)] border border-border">
              <Image
                src="/kortix-symbol.svg"
                alt="Suna"
                width={16}
                height={16}
                className={theme === 'dark' ? 'invert' : ''}
              />
            </div>
            <span className="text-sm font-medium">Suna</span>
          </motion.div>
        )}
        <MessageContent 
          content={content} 
          role={role} 
          isPartOfChain={isPartOfChain}
        />
      </div>
    </motion.div>
  );
}

export function ThinkingIndicator() {
  const { theme } = useTheme();
  
  return (
    <motion.div 
      className="w-full px-4 py-3 flex flex-col bg-muted/[0.03]"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
    >
      <div className="w-full max-w-5xl mx-auto">
        <motion.div 
          className="flex items-center gap-2 mb-2"
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.1 }}
        >
          <div className="flex items-center bg-background rounded-full size-8 flex-shrink-0 justify-center shadow-[0_0_10px_rgba(0,0,0,0.05)] border border-border">
            <Image
              src="/kortix-symbol.svg"
              alt="Suna"
              width={16}
              height={16}
              className={theme === 'dark' ? 'invert' : ''}
            />
          </div>
          <span className="text-sm font-medium">Suna</span>
        </motion.div>
        
        <div className="w-full overflow-hidden rounded-xl border border-border/40 bg-background/50 backdrop-blur-sm shadow-[0_0_15px_rgba(0,0,0,0.03)]">
          <div className="p-4">
            <div className="flex gap-1.5">
              {[0, 1, 2].map((index) => (
                <motion.div
                  key={index}
                  className="w-2 h-2 bg-primary/40 rounded-full"
                  animate={{ y: [0, -5, 0] }}
                  transition={{
                    duration: 0.6,
                    repeat: Infinity,
                    delay: index * 0.2,
                    ease: "easeInOut",
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
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