"use client";

import React, { forwardRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CodeRenderer } from "./code-renderer";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer = forwardRef<HTMLDivElement, MarkdownRendererProps>(
  ({ content, className }, ref) => {
    return (
      <ScrollArea className={cn("w-full h-full rounded-md relative", className)}>
        <div className="p-4 markdown prose prose-sm dark:prose-invert max-w-none" ref={ref}>
          <ReactMarkdown
            rehypePlugins={[rehypeRaw, rehypeSanitize]}
            components={{
              code(props) {
                const { className, children, ...rest } = props;
                const match = /language-(\w+)/.exec(className || "");
                
                // Check if it's an inline code block by examining the node type
                const isInline = !className || !match;
                
                if (isInline) {
                  return (
                    <code className={className} {...rest}>
                      {children}
                    </code>
                  );
                }

                return (
                  <CodeRenderer
                    content={String(children).replace(/\n$/, "")}
                    language={match ? match[1] : ""}
                  />
                );
              },
              // Style other elements as needed
              h1: ({ node, ...props }) => <h1 className="text-2xl font-bold my-4" {...props} />,
              h2: ({ node, ...props }) => <h2 className="text-xl font-bold my-3" {...props} />,
              h3: ({ node, ...props }) => <h3 className="text-lg font-bold my-2" {...props} />,
              a: ({ node, ...props }) => <a className="text-primary hover:underline" {...props} />,
              p: ({ node, ...props }) => <p className="my-2" {...props} />,
              ul: ({ node, ...props }) => <ul className="list-disc pl-5 my-2" {...props} />,
              ol: ({ node, ...props }) => <ol className="list-decimal pl-5 my-2" {...props} />,
              li: ({ node, ...props }) => <li className="my-1" {...props} />,
              blockquote: ({ node, ...props }) => (
                <blockquote className="border-l-4 border-muted pl-4 italic my-2" {...props} />
              ),
              img: ({ node, ...props }) => (
                <img className="max-w-full h-auto rounded-md my-2" {...props} alt={props.alt || ""} />
              ),
              pre: ({ node, ...props }) => <pre className="p-0 my-2 bg-transparent" {...props} />,
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </ScrollArea>
    );
  }
);

MarkdownRenderer.displayName = "MarkdownRenderer"; 