import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Streamdown } from "streamdown";
import { useSmoothText } from "@/hooks/messages";

interface ReasoningSectionProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

export function ReasoningSection({ content, className, isStreaming = false }: ReasoningSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  // User controls expansion manually - no auto-expand
  // Section appears immediately when streaming starts, user can expand/collapse as needed

  // Always show the section - it will appear as soon as agent starts
  // Content can be empty initially and will populate as chunks arrive
  const hasContent = content && content.trim().length > 0;
  
  // Apply smooth text animation for reasoning content (similar to normal text streaming)
  // Use ~50 chars/second for smooth reasoning display
  // Enable animation whenever streaming is active (even before content arrives)
  // This ensures smooth streaming as soon as first chunk arrives
  const smoothReasoningContent = useSmoothText(content, { speed: 50 });
  
  // Use smooth content for display
  const displayContent = smoothReasoningContent;
  const isCurrentlyStreaming = isStreaming;

  return (
    <div className={cn("w-full", className)}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-all duration-200 w-full text-left py-1.5 group"
      >
        <motion.div
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2, ease: "easeInOut" }}
          className="flex-shrink-0"
        >
          <ChevronDown className="h-4 w-4" />
        </motion.div>
        <span className="font-medium">
          {isExpanded ? "Hide Reasoning" : "Show Reasoning"}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ 
              duration: 0.25, 
              ease: [0.25, 0.1, 0.25, 1],
              opacity: { duration: 0.2 }
            }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 pl-6">
              {hasContent ? (
                <div className="text-sm break-words italic text-muted-foreground">
                  <Streamdown
                    isAnimating={isCurrentlyStreaming}
                    components={{
                      p: ({ children }) => (
                        <p className="text-sm text-muted-foreground leading-relaxed my-2 first:mt-0 last:mb-0 italic">
                          {children}
                        </p>
                      ),
                      h1: ({ children }) => (
                        <h1 className="text-base font-semibold text-muted-foreground mt-4 mb-2 first:mt-0 italic">
                          {children}
                        </h1>
                      ),
                      h2: ({ children }) => (
                        <h2 className="text-sm font-semibold text-muted-foreground mt-3 mb-2 first:mt-0 italic">
                          {children}
                        </h2>
                      ),
                      h3: ({ children }) => (
                        <h3 className="text-sm font-medium text-muted-foreground mt-2 mb-1 first:mt-0 italic">
                          {children}
                        </h3>
                      ),
                      ul: ({ children }) => (
                        <ul className="my-2 ml-4 list-disc marker:text-muted-foreground/60 space-y-1 text-sm">
                          {children}
                        </ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="my-2 ml-4 list-decimal marker:text-muted-foreground/60 space-y-1 text-sm">
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => (
                        <li className="text-sm text-muted-foreground leading-relaxed italic">
                          {children}
                        </li>
                      ),
                      code: ({ children, className: codeClassName }) => {
                        const match = /language-(\w+)/.exec(codeClassName || '');
                        const code = String(children).replace(/\n$/, '');
                        const isBlock = codeClassName?.includes('language-') || code.includes('\n');
                        
                        if (isBlock) {
                          return (
                            <code className="text-xs font-mono leading-relaxed text-foreground whitespace-pre block my-2 p-2 rounded bg-muted/50 border border-border/40">
                              {children}
                            </code>
                          );
                        }
                        
                        return (
                          <code className="px-1 py-0.5 rounded text-xs font-mono bg-muted/50 border border-border/40 text-foreground">
                            {children}
                          </code>
                        );
                      },
                      pre: ({ children }) => (
                        <pre className="my-2 overflow-x-auto">
                          {children}
                        </pre>
                      ),
                      blockquote: ({ children }) => (
                        <blockquote className="my-2 pl-3 py-1 text-sm border-l-2 border-border text-muted-foreground italic">
                          {children}
                        </blockquote>
                      ),
                      strong: ({ children }) => (
                        <strong className="font-semibold text-foreground not-italic">
                          {children}
                        </strong>
                      ),
                      em: ({ children }) => (
                        <em className="italic text-muted-foreground">
                          {children}
                        </em>
                      ),
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          target={href?.startsWith('http') ? '_blank' : undefined}
                          rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
                          className="text-muted-foreground underline decoration-muted-foreground/30 underline-offset-2 hover:decoration-muted-foreground/60 transition-colors italic"
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {displayContent}
                  </Streamdown>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground italic">
                  Waiting for reasoning content...
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

