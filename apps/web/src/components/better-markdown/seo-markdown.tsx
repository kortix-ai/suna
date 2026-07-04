"use client";

import { cn } from "@/lib/utils";
import Link from "next/link";
import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { PreviewImage, PreviewImageContent, PreviewImageTrigger } from "../ui/preview-image";
import { CodeBlock } from "./markdown-code-block";

interface SEOMarkdownRendererProps {
  content: string;
}

const getTextContent = (value: ReactNode): string => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(getTextContent).join("");
  if (isValidElement<{ children?: ReactNode }>(value))
    return getTextContent(value.props.children ?? "");
  return "";
};

const components: Components = {
  pre: ({ children }) => {
    const firstChild = Children.toArray(children)[0];
    if (!isValidElement<{ className?: string; children?: ReactNode }>(firstChild)) {
      return <pre>{children}</pre>;
    }

    const className = firstChild.props.className ?? "";
    const languageMatch = /language-([\w-]+)/.exec(className);
    const language = languageMatch?.[1] ?? "";
    const rawCode = getTextContent(firstChild.props.children).replace(/\n$/, "");

    return <CodeBlock code={rawCode} language={language} />;
  },
  code: ({ children }) => (
    <code className="bg-sidebar-accent text-primary/80 dark:bg-card relative rounded-sm px-1.5 py-[0.1rem] font-mono text-[0.9rem] [&>span]:bg-transparent">
      {children}
    </code>
  ),
  h1: ({ children }) => (
    <h1 className="text-primary mt-10 mb-4 text-xl font-semibold">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-primary mt-10 mb-4 text-xl font-semibold">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-primary mt-10 mb-4 text-xl font-semibold">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-primary mt-10 mb-4 text-xl font-semibold">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-primary mt-10 mb-4 text-xl font-semibold">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-primary mt-10 mb-4 text-xl font-semibold">{children}</h6>
  ),
  p: ({ children }) => (
    <p className="text-primary/80 text-[15px] leading-relaxed font-semibold">{children}</p>
  ),
  span: ({ children }) => (
    <span className="text-primary/80 text-[15px] leading-relaxed font-semibold">{children}</span>
  ),
  ul: ({ children }) => (
    <ul className="text-primary/80 mb-4 list-outside list-disc space-y-1 pl-6 [&_p]:mb-2 [&_p]:last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="text-primary/80 mb-4 list-outside list-disc space-y-1 pl-6 [&_p]:mb-2 [&_p]:last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="text-primary/80 leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <Link
      href={href ?? "#"}
      target="_blank"
      className="text-actrun-blue gap-1.5 rounded-md bg-transparent text-sm leading-relaxed font-medium underline underline-offset-auto"
    >
      {children}
    </Link>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 pl-6 italic [&:not(:first-child)]:my-5">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="border-border mt-6 w-full overflow-hidden overflow-y-auto rounded-md border">
      <table className="w-full">{children}</table>
    </div>
  ),
  th: ({ children, className }) => (
    <th
      className={cn(
        "bg-card border-b px-4 py-2 text-left text-[0.95rem] font-semibold [&[align=center]]:text-center [&[align=right]]:text-right",
        "text-[0.95rem]",
        className,
      )}
    >
      {children}
    </th>
  ),
  tr: ({ children, className }) => (
    <tr className={cn("border-border bg-background border-b last:border-b-0", className)}>
      {children}
    </tr>
  ),
  td: ({ children, className }) => (
    <td
      className={cn(
        "px-4 py-2 text-left text-[0.95rem] font-normal [&[align=center]]:text-center [&[align=right]]:text-right",
        "text-[0.95rem]",
        className,
      )}
    >
      {children}
    </td>
  ),
  img: ({ src, alt }) => (
    <PreviewImage>
      <PreviewImageTrigger asChild>
        <img
          src={src}
          alt={alt}
          className="h-auto max-w-full cursor-zoom-in rounded-lg border object-contain"
        />
      </PreviewImageTrigger>
      <PreviewImageContent fileContent={src as string} fileName={alt} />
    </PreviewImage>
  ),
  hr: () => <hr className="border-primary/20 border-t [&:not(:first-child)]:my-4" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
};

export function SEOMarkdownRenderer({ content }: SEOMarkdownRendererProps) {
  return (
    <div
      className={cn(
        "text-primary/85 space-y-4 text-sm",
        "[&_.shiki]:!bg-transparent [&_.shiki_pre]:!bg-transparent",
        "[&_.shiki_span]:!bg-transparent",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
