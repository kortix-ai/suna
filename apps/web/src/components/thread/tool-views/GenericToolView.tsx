'use client'

import React, { useState, useMemo } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Ban,
  Wrench,
  Copy,
  Check,
  ChevronRight,
  ChevronDown,
  ArrowDownToLine,
  ArrowUpFromLine,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolViewProps } from './types';
import { getToolTitle } from './utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from '@/components/ui/button';
import { LoadingState } from './shared/LoadingState';
import { toast } from '@/lib/toast';
import { SmartJsonViewer } from './shared/SmartJsonViewer';
import { ToolViewIconTitle } from './shared/ToolViewIconTitle';
import { ToolViewFooter } from './shared/ToolViewFooter';
import { useSmoothStream } from '@/lib/streaming';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import {
  type OutputSection as OutputSectionType,
  normalizeToolOutput,
  hasStructuredContent,
  parseStructuredOutput,
} from '@/lib/utils/structured-output';

/** Strip XML wrapper tags like <skill_content> and detect if content looks like markdown */
function extractMarkdownContent(text: string): { content: string; isMarkdown: boolean } {
  let content = text;
  // Strip <skill_content ...> ... </skill_content> wrapper
  const skillMatch = content.match(/^<skill_content[^>]*>\s*([\s\S]*?)\s*<\/skill_content>\s*$/);
  if (skillMatch) {
    content = skillMatch[1];
  }
  // Detect markdown: headers, bold, lists, code blocks, links
  const isMarkdown = /^#{1,6}\s|^\*\*|^\- |\n#{1,6}\s|\n\*\*|\n\- |```/.test(content);
  return { content, isMarkdown };
}

export function GenericToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const parseContent = React.useCallback((content: any): any => {
    if (!content) return null;

    if (typeof content === 'object') {
      return content;
    }

    if (typeof content === 'string') {
      const textContentMatch = content.match(/text=(['"])((?:(?!\1|\\).|\\.)*)\1/);
      
      if (textContentMatch) {
         try {
           let jsonStr = textContentMatch[2];
           if (textContentMatch[1] === "'") {
             jsonStr = jsonStr.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
           } else {
             jsonStr = jsonStr.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
           }
           
           try {
             return JSON.parse(jsonStr);
           } catch {
             return jsonStr;
           }
         } catch (e) {
         }
      }

      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === 'string') {
           try {
             return JSON.parse(parsed);
           } catch {
             return parsed;
           }
        }
        return parsed;
      } catch (e) {
      }
    }
    
    return content;
  }, []);

  // Format arguments from toolCall
  const parsedAssistantContent = React.useMemo(
    () => parseContent(toolCall?.arguments),
    [toolCall?.arguments, parseContent],
  );
  
  // Format output from toolResult
  const parsedToolContent = React.useMemo(
    () => toolResult ? parseContent(toolResult.output) : null,
    [toolResult, parseContent],
  );

  const formatAsString = (content: any) => {
    if (typeof content === 'object' && content !== null) {
      return JSON.stringify(content, null, 2);
    }
    return String(content);
  };

  const rawAssistantContent = React.useMemo(
    () => parsedAssistantContent ? formatAsString(parsedAssistantContent) : null,
    [parsedAssistantContent]
  );

  // Apply smooth text streaming for arguments when streaming
  const smoothAssistantContent = useSmoothStream(
    rawAssistantContent || '',
    true
  );
  const isAssistantAnimating = isStreaming && !toolResult && !!rawAssistantContent;

  const formattedAssistantContent = isStreaming && smoothAssistantContent ? smoothAssistantContent : rawAssistantContent;

  const formattedToolContent = React.useMemo(
    () => parsedToolContent ? formatAsString(parsedToolContent) : null,
    [parsedToolContent]
  );

  // Add copy functionality state
  const [isCopyingInput, setIsCopyingInput] = React.useState(false);
  const [isCopyingOutput, setIsCopyingOutput] = React.useState(false);

  // Collapsible state for input/output sections
  const [inputExpanded, setInputExpanded] = React.useState(true);
  const [outputExpanded, setOutputExpanded] = React.useState(true);

  // Copy functions
  const copyToClipboard = React.useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.error('Failed to copy text: ', err);
      return false;
    }
  }, []);

  const handleCopyInput = React.useCallback(async () => {
    if (!formattedAssistantContent) return;

    setIsCopyingInput(true);
    const success = await copyToClipboard(formattedAssistantContent);
    if (success) {
      toast.success('Input copied to clipboard');
    } else {
      toast.error('Failed to copy input');
    }
    setTimeout(() => setIsCopyingInput(false), 500);
  }, [formattedAssistantContent, copyToClipboard]);

  const handleCopyOutput = React.useCallback(async () => {
    if (!formattedToolContent) return;

    setIsCopyingOutput(true);
    const success = await copyToClipboard(formattedToolContent);
    if (success) {
      toast.success('Output copied to clipboard');
    } else {
      toast.error('Failed to copy output');
    }
    setTimeout(() => setIsCopyingOutput(false), 500);
  }, [formattedToolContent, copyToClipboard]);

  const isError = React.useMemo(() => {
    if (toolResult?.success === false) return true;
    if (toolResult?.error) return true;
    
    if (typeof toolResult?.output === 'string') {
      const output = toolResult.output.toLowerCase();
      if (output.startsWith('error:') || output.includes('failed') || output.includes('exception')) {
        return true;
      }
    }
    
    return !isSuccess;
  }, [toolResult, isSuccess]);

  const errorMessage = React.useMemo(() => {
    if (!isError) return null;
    
    if (toolResult?.error) return String(toolResult.error);
    if (typeof toolResult?.output === 'string') return toolResult.output;
    
    return 'Tool execution failed';
  }, [isError, toolResult]);

  if (!toolCall || !toolCall.function_name) {
    console.warn('GenericToolView: toolCall is undefined or missing function_name. Tool views should use structured props.');
    return (
      <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
        <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
          <CardTitle className="text-[12.5px] font-medium text-foreground tracking-tight">
            Tool View Error
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground">
            This tool view requires structured metadata. Please update the component to use toolCall and toolResult props.
          </p>
        </CardContent>
      </Card>
    );
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = (toolCall as any)._display_hint || getToolTitle(name);

  // Count input keys for badge
  const inputKeyCount = typeof parsedAssistantContent === 'object' && parsedAssistantContent !== null
    ? Object.keys(parsedAssistantContent).length
    : null;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={Wrench}
            title={toolTitle}
          />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            title={toolTitle}
            subtitle={name}
            showProgress={true}
          />
        ) : isError ? (
          <div className="flex flex-col h-full">
            <ScrollArea className="flex-1 w-full">
              <div className="p-3 space-y-2">
                {/* Structured error display */}
                <GenericToolErrorDisplay
                  errorMessage={errorMessage}
                  formattedToolContent={formattedToolContent}
                  parsedToolContent={parsedToolContent}
                />

                {/* Input section (collapsed by default for errors) */}
                {formattedAssistantContent && (
                  <CollapsibleSection
                    label="Input"
                    icon={ArrowUpFromLine}
                    expanded={false}
                    keyCount={inputKeyCount}
                    onCopy={handleCopyInput}
                    isCopying={isCopyingInput}
                  >
                    {typeof parsedAssistantContent === 'object' && parsedAssistantContent !== null ? (
                      <SmartJsonViewer data={parsedAssistantContent} />
                    ) : (
                      <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                        {formattedAssistantContent}
                      </pre>
                    )}
                  </CollapsibleSection>
                )}
              </div>
            </ScrollArea>
          </div>
        ) : formattedAssistantContent || formattedToolContent ? (
          <ScrollArea className="h-full w-full">
            <div className="p-3 space-y-2">
              {/* Input section */}
              {formattedAssistantContent && (
                <CollapsibleSection
                  label="Input"
                  icon={ArrowUpFromLine}
                  expanded={inputExpanded}
                  onToggle={() => setInputExpanded(!inputExpanded)}
                  keyCount={inputKeyCount}
                  onCopy={handleCopyInput}
                  isCopying={isCopyingInput}
                >
                  {typeof parsedAssistantContent === 'object' && parsedAssistantContent !== null ? (
                    <SmartJsonViewer data={parsedAssistantContent} />
                  ) : (
                    <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                      {formattedAssistantContent}
                      {isAssistantAnimating && <span className="animate-pulse text-muted-foreground">|</span>}
                    </pre>
                  )}
                </CollapsibleSection>
              )}

              {/* Output section */}
              {formattedToolContent && (
                <CollapsibleSection
                  label="Output"
                  icon={ArrowDownToLine}
                  expanded={outputExpanded}
                  onToggle={() => setOutputExpanded(!outputExpanded)}
                  onCopy={handleCopyOutput}
                  isCopying={isCopyingOutput}
                >
                  {typeof parsedToolContent === 'object' && parsedToolContent !== null ? (
                    <SmartJsonViewer data={parsedToolContent} />
                  ) : (() => {
                    // Try structured output rendering for warnings/tracebacks
                    const normalized = normalizeToolOutput(formattedToolContent || '');
                    if (hasStructuredContent(normalized)) {
                      const sections = parseStructuredOutput(normalized);
                      return <GenericStructuredOutputDisplay sections={sections} />;
                    }
                    const { content, isMarkdown } = extractMarkdownContent(formattedToolContent || '');
                    return isMarkdown ? (
                      <div className="text-sm prose prose-sm dark:prose-invert max-w-none">
                        <UnifiedMarkdown content={content} isStreaming={false} />
                      </div>
                    ) : (
                      <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                        {formattedToolContent}
                      </pre>
                    );
                  })()}
                </CollapsibleSection>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6">
            <div className="w-10 h-10 rounded-full flex items-center justify-center mb-3 bg-muted">
              <Wrench className="h-5 w-5 text-muted-foreground" />
            </div>
            <h3 className="text-sm font-medium mb-1 text-foreground">
              No Content Available
            </h3>
            <p className="text-xs text-muted-foreground text-center max-w-md">
              This tool execution did not produce any input or output content to display.
            </p>
          </div>
        )}
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (formattedAssistantContent || formattedToolContent || isError) && (
          isError ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-red-500/90 tracking-tight">
              <AlertCircle className="w-3 h-3" />
              Failed
            </span>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              Completed
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}

/* ---------- Collapsible Section ---------- */

function CollapsibleSection({
  label,
  icon: Icon,
  expanded: controlledExpanded,
  onToggle,
  keyCount,
  onCopy,
  isCopying,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  expanded?: boolean;
  onToggle?: () => void;
  keyCount?: number | null;
  onCopy?: () => void;
  isCopying?: boolean;
  children: React.ReactNode;
}) {
  const [internalExpanded, setInternalExpanded] = useState(controlledExpanded ?? true);
  const isExpanded = onToggle ? (controlledExpanded ?? true) : internalExpanded;
  const handleToggle = onToggle ?? (() => setInternalExpanded(v => !v));

  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card">
      {/* Section header */}
      <div
        className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors group"
        onClick={handleToggle}
      >
        {isExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <Icon className="h-3.5 w-3.5 text-muted-foreground/70 flex-shrink-0" />
        <span className="text-xs font-medium text-foreground flex-1">
          {label}
        </span>
        {keyCount != null && keyCount > 0 && !isExpanded && (
          <span className="text-[10px] text-muted-foreground/50 font-mono">
            {keyCount} {keyCount === 1 ? 'field' : 'fields'}
          </span>
        )}
        {onCopy && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => { e.stopPropagation(); onCopy(); }}
            disabled={isCopying}
            className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
            title={`Copy ${label.toLowerCase()}`}
          >
            {isCopying ? (
              <Check className="h-3 w-3 text-emerald-500" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground" />
            )}
          </Button>
        )}
      </div>

      {/* Section content */}
      {isExpanded && (
        <div className="border-t border-border px-3 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

/* ---------- Structured Output Display ---------- */

/** Render parsed structured output sections with semantic styling (for detail panel). */
function GenericStructuredOutputDisplay({ sections }: { sections: OutputSectionType[] }) {
  const [showTrace, setShowTrace] = useState(false);

  return (
    <div className="space-y-2">
      {sections.map((section, i) => {
        switch (section.type) {
          case 'warning':
            return (
              <div
                key={i}
                className="flex items-start gap-2.5 px-3 py-2 rounded-md bg-foreground/[0.03] border border-border/50"
              >
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-muted-foreground/70" />
                <p className="text-[12px] leading-relaxed text-foreground/80 font-mono break-words">
                  {section.text}
                </p>
              </div>
            );

          case 'error':
            return (
              <div
                key={i}
                className="flex items-start gap-2.5 px-3 py-2 rounded-md bg-red-500/[0.04] border border-red-500/25"
              >
                <Ban className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-red-500/90" />
                <div className="min-w-0 flex-1">
                  {section.errorType && (
                    <span className="text-[10px] font-semibold text-red-500/80 uppercase tracking-wider">
                      {section.errorType}
                    </span>
                  )}
                  <p className="text-[12px] leading-relaxed text-foreground/80 font-mono break-words">
                    {section.summary}
                  </p>
                </div>
              </div>
            );

          case 'traceback':
            return (
              <div key={i}>
                <button
                  onClick={() => setShowTrace((v) => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30 transition-colors cursor-pointer w-full text-left"
                >
                  <ChevronRight
                    className={cn(
                      'h-3.5 w-3.5 transition-transform flex-shrink-0',
                      showTrace && 'rotate-90',
                    )}
                  />
                  <span className="text-xs font-medium">Stack trace</span>
                  <span className="text-[10px] text-muted-foreground/40 font-mono ml-1">
                    {section.lines.length} lines
                  </span>
                </button>
                {showTrace && (
                  <div className="mt-1 rounded-lg bg-muted/20 border border-border/30 overflow-hidden">
                    <pre className="p-3 font-mono text-[10px] leading-relaxed text-muted-foreground/60 whitespace-pre-wrap break-all max-h-80 overflow-auto">
                      {section.lines.map((line, li) => {
                        if (/^\s+File "/.test(line)) {
                          return (
                            <span key={li} className="text-muted-foreground/80">
                              {line}
                              {'\n'}
                            </span>
                          );
                        }
                        return (
                          <span key={li}>
                            {line}
                            {'\n'}
                          </span>
                        );
                      })}
                    </pre>
                  </div>
                )}
              </div>
            );

          case 'install':
            return (
              <div
                key={i}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md bg-foreground/[0.03] border border-border/50"
              >
                <CheckCircle className="h-3.5 w-3.5 flex-shrink-0 text-foreground/70" />
                <span className="text-[12px] text-foreground/80 font-mono">
                  {section.text}
                </span>
              </div>
            );

          case 'info':
            return (
              <div
                key={i}
                className="flex items-center gap-2.5 px-3 py-1.5 text-xs text-muted-foreground font-mono"
              >
                <span className="size-1.5 rounded-full bg-muted-foreground/30 flex-shrink-0" />
                <span className="break-words">{section.text}</span>
              </div>
            );

          case 'plain':
            return (
              <pre
                key={i}
                className="px-3 py-1.5 font-mono text-xs leading-relaxed text-foreground/70 whitespace-pre-wrap break-words"
              >
                {section.text}
              </pre>
            );

          default:
            return null;
        }
      })}
    </div>
  );
}

/* ---------- Error Display ---------- */

/** Structured error display with collapsible traceback */
function GenericToolErrorDisplay({
  errorMessage,
  formattedToolContent,
  parsedToolContent,
}: {
  errorMessage: string | null;
  formattedToolContent: string | null;
  parsedToolContent: any;
}) {
  const [showTrace, setShowTrace] = useState(false);

  const errorText = formattedToolContent || errorMessage || 'Tool execution failed';

  // Try structured rendering for error output with warnings/tracebacks
  const structuredSections = React.useMemo(() => {
    if (typeof parsedToolContent === 'object' && parsedToolContent !== null) return null;
    const normalized = normalizeToolOutput(errorText);
    if (!hasStructuredContent(normalized)) return null;
    return parseStructuredOutput(normalized);
  }, [errorText, parsedToolContent]);

  // Parse validation issues from JSON error strings
  interface ValidationIssue {
    code: string;
    message: string;
    path: string[];
    values?: string[];
  }

  const { summary, traceback, errorType, validationIssues } = React.useMemo(() => {
    const cleaned = errorText.replace(/^Error:\s*/, '');

    // Try to detect JSON validation errors (Zod-style arrays of issues)
    const trimmed = cleaned.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        if (arr.length > 0 && arr.every((item: any) => item && typeof item === 'object' && 'message' in item)) {
          const issues: ValidationIssue[] = arr.map((item: any) => ({
            code: item.code || 'error',
            message: item.message || String(item),
            path: Array.isArray(item.path) ? item.path.map(String) : [],
            values: Array.isArray(item.values) ? item.values.map(String) : undefined,
          }));
          const first = issues[0];
          const pathStr = first.path.length > 0 ? first.path.join('.') : '';
          const sum = pathStr ? `${pathStr}: ${first.message}` : first.message;
          return { summary: sum, traceback: null, errorType: 'Validation Error' as string | null, validationIssues: issues as ValidationIssue[] | null };
        }
      } catch {
        // Not valid JSON
      }
    }

    // Python-style traceback
    const tbIdx = cleaned.indexOf('Traceback (most recent call last):');
    if (tbIdx >= 0) {
      const before = cleaned.slice(0, tbIdx).trim();
      const traceSection = cleaned.slice(tbIdx);
      const lines = traceSection.split('\n').filter((l: string) => l.trim());
      const lastLine = lines[lines.length - 1] || '';
      const typeMatch = lastLine.match(/^([\w._]+(?:Error|Exception|Warning)):\s*/);
      const errType = typeMatch ? typeMatch[1].split('.').pop() || typeMatch[1] : null;
      const sum = before || (errType ? lastLine : lastLine.slice(0, 150));
      return { summary: sum, traceback: traceSection, errorType: errType, validationIssues: null as ValidationIssue[] | null };
    }

    // Node.js-style stack
    const stackIdx = cleaned.indexOf('\n    at ');
    if (stackIdx >= 0) {
      return { summary: cleaned.slice(0, stackIdx).trim(), traceback: cleaned.slice(stackIdx), errorType: null, validationIssues: null as ValidationIssue[] | null };
    }

    return { summary: cleaned.length > 300 ? cleaned.slice(0, 300) + '...' : cleaned, traceback: cleaned.length > 300 ? cleaned : null, errorType: null, validationIssues: null as ValidationIssue[] | null };
  }, [errorText]);

  const displayType = errorType || 'Error';

  // If structured output was detected, render it
  if (structuredSections) {
    return <GenericStructuredOutputDisplay sections={structuredSections} />;
  }

  // Render validation issues with structured layout
  if (validationIssues && validationIssues.length > 0) {
    return (
      <div className="rounded-md border border-red-500/25 bg-red-500/[0.04] overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-red-500/10">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />
          <span className="text-xs font-medium text-red-400">{displayType}</span>
        </div>
        <div className="px-3 py-2.5 space-y-2.5">
          {validationIssues.map((issue, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-3 w-3 flex-shrink-0 text-red-400/70 mt-0.5" />
                <div className="min-w-0 flex-1">
                  {issue.path.length > 0 && (
                    <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-red-500/[0.08] text-red-500/85 font-mono mr-1.5">
                      {issue.path.join('.')}
                    </span>
                  )}
                  <span className="text-xs text-foreground/80">
                    {issue.message}
                  </span>
                </div>
              </div>
              {issue.values && issue.values.length > 0 && (
                <div className="ml-5">
                  <div className="text-[10px] text-muted-foreground/50 mb-1">Expected one of:</div>
                  <div className="flex flex-wrap gap-1">
                    {issue.values.map((val, vi) => (
                      <span
                        key={vi}
                        className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted/40 text-muted-foreground/70 font-mono"
                      >
                        {val}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // If the content is structured JSON, show it with SmartJsonViewer
  if (typeof parsedToolContent === 'object' && parsedToolContent !== null) {
    return (
      <div className="rounded-md border border-red-500/25 bg-red-500/[0.04] overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-red-500/10">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />
          <span className="text-xs font-medium text-red-400">Error</span>
        </div>
        <div className="p-3">
          <SmartJsonViewer data={parsedToolContent} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-red-500/25 bg-red-500/[0.04] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-red-500/10">
        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />
        <span className="text-xs font-medium text-red-400">{displayType}</span>
      </div>

      {/* Summary */}
      <div className="px-3 py-2.5">
        <p className="text-xs text-foreground/80 leading-relaxed break-words whitespace-pre-wrap font-mono">
          {summary}
        </p>
      </div>

      {/* Collapsible stack trace */}
      {traceback && (
        <>
          <button
            onClick={() => setShowTrace((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 w-full text-left border-t border-red-500/10 text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer"
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', showTrace ? 'rotate-90' : '')} />
            <span className="text-[10px] font-medium">
              {traceback.includes('Traceback') ? 'Stack trace' : 'Full output'}
            </span>
          </button>
          {showTrace && (
            <div className="px-3 pb-2.5 max-h-64 overflow-auto">
              <pre className="font-mono text-[10px] leading-relaxed text-muted-foreground/60 whitespace-pre-wrap break-all">
                {traceback}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
