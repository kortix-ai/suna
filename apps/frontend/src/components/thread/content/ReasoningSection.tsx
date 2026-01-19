import React, { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Streamdown } from "streamdown";
import { useSmoothText } from "@/hooks/messages";

interface ReasoningSectionProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  /** Whether reasoning is actively being generated (for shimmer effect) */
  isReasoningActive?: boolean;
  /** Whether reasoning generation is complete */
  isReasoningComplete?: boolean;
  /** Whether this is persisted content (from server) vs streaming content */
  isPersistedContent?: boolean;
  /** Controlled mode: external expanded state */
  isExpanded?: boolean;
  /** Controlled mode: callback when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void;
}

export function ReasoningSection({
  content,
  className,
  isStreaming = false,
  isReasoningActive = false,
  isReasoningComplete = false,
  isPersistedContent = false,
  isExpanded: controlledExpanded,
  onExpandedChange,
}: ReasoningSectionProps) {
  // Support both controlled and uncontrolled modes
  const [internalExpanded, setInternalExpanded] = useState(isStreaming);
  const [hasAutoExpanded, setHasAutoExpanded] = useState(false);

  // Use controlled mode if external state is provided
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : internalExpanded;
  const setIsExpanded = (expanded: boolean) => {
    if (isControlled && onExpandedChange) {
      onExpandedChange(expanded);
    } else {
      setInternalExpanded(expanded);
    }
  };

  // Determine if shimmer should be active (reasoning is being generated and not complete)
  const shouldShimmer = (isReasoningActive || isStreaming) && !isReasoningComplete;

  // Auto-expand when streaming starts (only once per stream)
  useEffect(() => {
    if (isStreaming && !hasAutoExpanded) {
      setIsExpanded(true);
      setHasAutoExpanded(true);
    }
    // Reset the flag when streaming stops so next stream can auto-expand
    if (!isStreaming) {
      setHasAutoExpanded(false);
    }
  }, [isStreaming, hasAutoExpanded]);

  const hasContent = content && content.trim().length > 0;

  // Apply smooth text animation for reasoning content
  const smoothReasoningContent = useSmoothText(content, { speed: 50 });
  const displayContent = smoothReasoningContent;
  const isCurrentlyStreaming = isStreaming;

  return (
    <div className={cn("w-full", className)}>
      {/* Header row: Full Kortix logo + Toggle button */}
      <div className="flex items-center gap-3">
        {/* Full Kortix logo (logomark with text) - pulses when reasoning is active */}
        <img
          src="/kortix-logomark-white.svg"
          alt="Kortix"
          className={cn(
            "flex-shrink-0 dark:invert-0 invert",
            shouldShimmer && "animate-pulse"
          )}
          style={{ height: '14px', width: 'auto' }}
        />

        {/* Show reasoning toggle button */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 py-1 group"
        >
          <span className={cn(
            "font-medium text-sm",
            shouldShimmer && "animate-text-shimmer"
          )}>
            {isExpanded ? "Hide Reasoning" : "Show Reasoning"}
          </span>
          <motion.div
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="flex-shrink-0"
          >
            <ChevronDown className={cn(
              "h-4 w-4",
              shouldShimmer && "animate-text-shimmer"
            )} />
          </motion.div>
        </button>
      </div>

      {/* Expandable content with left border */}
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
            {/* Content container with left border indentation */}
            <div className="mt-1.5 ml-2.5 pl-4 border-l-2 border-muted-foreground/20">
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
