import React, { useState, useRef, useEffect, memo } from "react";
import { ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Streamdown } from "streamdown";

interface ReasoningSectionProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  isReasoningActive?: boolean;
  isReasoningComplete?: boolean;
  isPersistedContent?: boolean;
  /** Controlled expanded state - if provided, component is controlled */
  isExpanded?: boolean;
  /** Callback when expanded state changes */
  onExpandedChange?: (expanded: boolean) => void;
}

// Memoized Streamdown components to prevent re-renders
const streamdownComponents = {
  p: ({ children }: { children: React.ReactNode }) => (
    <p className="text-sm text-muted-foreground leading-relaxed my-2 first:mt-0 last:mb-0 italic">
      {children}
    </p>
  ),
  h1: ({ children }: { children: React.ReactNode }) => (
    <h1 className="text-base font-semibold text-muted-foreground mt-4 mb-2 first:mt-0 italic">
      {children}
    </h1>
  ),
  h2: ({ children }: { children: React.ReactNode }) => (
    <h2 className="text-sm font-semibold text-muted-foreground mt-3 mb-2 first:mt-0 italic">
      {children}
    </h2>
  ),
  h3: ({ children }: { children: React.ReactNode }) => (
    <h3 className="text-sm font-medium text-muted-foreground mt-2 mb-1 first:mt-0 italic">
      {children}
    </h3>
  ),
  ul: ({ children }: { children: React.ReactNode }) => (
    <ul className="my-2 ml-4 list-disc marker:text-muted-foreground/60 space-y-1 text-sm">
      {children}
    </ul>
  ),
  ol: ({ children }: { children: React.ReactNode }) => (
    <ol className="my-2 ml-4 list-decimal marker:text-muted-foreground/60 space-y-1 text-sm">
      {children}
    </ol>
  ),
  li: ({ children }: { children: React.ReactNode }) => (
    <li className="text-sm text-muted-foreground leading-relaxed italic">
      {children}
    </li>
  ),
  code: ({ children, className: codeClassName }: { children: React.ReactNode; className?: string }) => {
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
  pre: ({ children }: { children: React.ReactNode }) => (
    <pre className="my-2 overflow-x-auto">
      {children}
    </pre>
  ),
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="my-2 pl-3 py-1 text-sm border-l-2 border-border text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  strong: ({ children }: { children: React.ReactNode }) => (
    <strong className="font-semibold text-foreground not-italic">
      {children}
    </strong>
  ),
  em: ({ children }: { children: React.ReactNode }) => (
    <em className="italic text-muted-foreground">
      {children}
    </em>
  ),
  a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
    <a
      href={href}
      target={href?.startsWith('http') ? '_blank' : undefined}
      rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
      className="text-muted-foreground underline decoration-muted-foreground/30 underline-offset-2 hover:decoration-muted-foreground/60 transition-colors italic"
    >
      {children}
    </a>
  ),
};

export const ReasoningSection = memo(function ReasoningSection({
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
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = controlledExpanded !== undefined;
  const isExpanded = isControlled ? controlledExpanded : internalExpanded;

  const handleToggle = () => {
    const newValue = !isExpanded;
    if (onExpandedChange) {
      onExpandedChange(newValue);
    }
    if (!isControlled) {
      setInternalExpanded(newValue);
    }
  };

  // Track if content has been fully rendered to prevent re-animation
  const hasRenderedRef = useRef(false);
  const lastContentLengthRef = useRef(0);

  // Mark as rendered once we have substantial content and streaming stops
  useEffect(() => {
    if (content.length > lastContentLengthRef.current) {
      lastContentLengthRef.current = content.length;
    }
    // Once streaming ends with content, mark as rendered
    if (!isStreaming && content.length > 0) {
      hasRenderedRef.current = true;
    }
  }, [content, isStreaming]);

  const hasContent = content && content.trim().length > 0;

  // Only animate if actively streaming AND content hasn't been fully rendered before
  // This prevents re-animation when toggling or when component re-renders
  const shouldAnimate = isStreaming && !isPersistedContent && !hasRenderedRef.current;

  // Determine if pulse animation should play
  // Pulse when: reasoning is active AND not complete AND not persisted
  const shouldPulse = isReasoningActive && !isReasoningComplete && !isPersistedContent;

  return (
    <div className={cn("w-full", className)}>
      {/* Header row: Icon + Toggle on same line */}
      <div className="flex items-center gap-2">
        {/* Pulsing Kortix Icon - always white (invert turns black SVG to white) */}
        <img
          src="/kortix-symbol.svg"
          alt="Kortix"
          className={cn(
            "h-5 w-5 flex-shrink-0 invert",
            shouldPulse && "animate-pulse-heartbeat"
          )}
        />

        {/* Show reasoning toggle button */}
        <button
          onClick={handleToggle}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 py-1 group"
        >
          <span className={cn(
            "font-medium text-[15px]",
            shouldPulse && "animate-text-shimmer"
          )}>Show reasoning</span>
          <motion.div
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="flex-shrink-0"
          >
            <ChevronDown className={cn(
              "h-4 w-4",
              shouldPulse && "animate-text-shimmer"
            )} />
          </motion.div>
        </button>
      </div>

      {/* Expandable content with white left border */}
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
            {/* Content container with white left border line */}
            <div className="mt-1.5 ml-2.5 pl-4 border-l-2 border-white/30 dark:border-white/20">
              {hasContent ? (
                <div className="text-sm break-words italic text-muted-foreground">
                  <Streamdown
                    isAnimating={shouldAnimate}
                    components={streamdownComponents}
                  >
                    {content}
                  </Streamdown>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground italic py-1">
                  Thinking...
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
