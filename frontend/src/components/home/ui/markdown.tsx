/* eslint-disable @typescript-eslint/no-explicit-any */
import { cn } from "@/lib/utils";
import { marked } from "marked";
import { memo, useId, useMemo } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, CodeBlockCode } from "./code-block";

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: Partial<Components>;
};

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map((token: any) => token.raw);
}

function extractLanguage(className?: string): string {
  if (!className) return "plaintext";
  const match = className.match(/language-(\w+)/);
  return match ? match[1] : "plaintext";
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }: any) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line;

    if (isInline) {
      return (
        <span
          className={cn(
            "bg-primary-foreground dark:bg-zinc-800 dark:border dark:border-zinc-700 rounded-sm px-1 font-mono text-sm",
            className
          )}
          {...props}
        >
          {children}
        </span>
      );
    }

    const language = extractLanguage(className);

    return (
      <CodeBlock className={className}>
        <CodeBlockCode code={children as string} language={language} />
      </CodeBlock>
    );
  },
  pre: function PreComponent({ children }: any) {
    return <>{children}</>;
  },
  ul: function UnorderedList({ children, ...props }: any) {
    return <ul className="list-disc pl-5 my-2" {...props}>{children}</ul>;
  },
  ol: function OrderedList({ children, ...props }: any) {
    return <ol className="list-decimal pl-5 my-2" {...props}>{children}</ol>;
  },
  li: function ListItem({ children, ...props }: any) {
    return <li className="my-1" {...props}>{children}</li>;
  },
  h1: function H1({ children, ...props }: any) {
    return <h1 className="text-2xl font-bold my-3" {...props}>{children}</h1>;
  },
  h2: function H2({ children, ...props }: any) {
    return <h2 className="text-xl font-bold my-2" {...props}>{children}</h2>;
  },
  h3: function H3({ children, ...props }: any) {
    return <h3 className="text-lg font-bold my-2" {...props}>{children}</h3>;
  },
  blockquote: function Blockquote({ children, ...props }: any) {
    return <blockquote className="border-l-4 border-muted pl-4 italic my-2 dark:text-zinc-400 dark:border-zinc-600" {...props}>{children}</blockquote>;
  },
  a: function Anchor({ children, href, ...props }: any) {
    return <a href={href} className="text-primary hover:underline dark:text-blue-400" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
  },
  table: function Table({ children, ...props }: any) {
    return <table className="w-full border-collapse my-3 text-sm" {...props}>{children}</table>;
  },
  th: function TableHeader({ children, ...props }: any) {
    return <th className="border border-slate-300 dark:border-zinc-700 px-3 py-2 text-left font-semibold bg-slate-100 dark:bg-zinc-800" {...props}>{children}</th>;
  },
  td: function TableCell({ children, ...props }: any) {
    return <td className="border border-slate-300 dark:border-zinc-700 px-3 py-2" {...props}>{children}</td>;
  },
};

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string;
    components?: Partial<Components>;
  }) {
    return (
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]} 
        components={components}
      >
        {content}
      </ReactMarkdown>
    );
  },
  function propsAreEqual(prevProps: any, nextProps: any) {
    return prevProps.content === nextProps.content;
  }
);

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
}: MarkdownProps) {
  const generatedId = useId();
  const blockId = id ?? generatedId;
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={components}
        />
      ))}
    </div>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";

export { Markdown };
