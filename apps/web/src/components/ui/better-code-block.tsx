'use client';

import { Icon } from '@/features/icon/icon';
import { useCopy } from '@/hooks/use-copy';
import { cleanCode } from '@/lib/codeCleaner';
import { getLanguageFromFilename, useHighlightedCode } from '@/lib/shiki';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import React from 'react';
import { MessageMarkdown } from '../better-markdown/message-markdown';
import { Button } from './button';
import Hint from './hint';

type CodeBlockCodeProps = {
  code: string;
  language?: string;
  className?: string;
  showCopyButton?: boolean;
  isTerminal?: boolean;
  showBackgroundColors?: boolean;
  parentClassName?: string;
  border?: boolean;
  padding?: string;
} & React.HTMLProps<HTMLDivElement>;

function HighlightedCode({
  code,
  language = 'typescript',
  classNames,
  showBackgroundColors,
  ...props
}: CodeBlockCodeProps & { classNames: string }) {
  const highlightedHtml = useHighlightedCode({ code, language, showBackgroundColors });

  return highlightedHtml ? (
    <div
      className={cn(classNames, 'h-full overflow-auto')}
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      {...props}
    />
  ) : (
    <div className={cn(classNames, 'h-full overflow-auto')} {...props}>
      <pre className="w-full rounded-md break-words whitespace-pre-wrap">
        <code className="overflow-wrap-anywhere break-words whitespace-pre-wrap">{code}</code>
      </pre>
    </div>
  );
}

function BetterCodeBlock({
  code,
  language = 'typescript',
  className,
  showCopyButton = true,
  isTerminal = false,
  showBackgroundColors = true,
  parentClassName,
  border = true,
  padding = 'p-4 [&>pre]:p-4',
  ...props
}: CodeBlockCodeProps) {
  const { copied, copy } = useCopy();

  const classNames = cn(
    'relative w-full h-full overflow-x-auto overflow-y-auto z-10 rounded-md text-[0.9rem]   overflow-y-auto',
    'whitespace-pre-wrap break-words ',
    '[&_code]:break-words [&_code]:whitespace-pre-wrap [&_code]:overflow-wrap-anywhere',
    '[&>pre]:w-full [&>pre]:break-words [&>pre]:whitespace-pre-wrap scrollbar-hide',
    'flex flex-col flex-1',
    !showBackgroundColors && '[&_.shiki]:!bg-transparent [&_.shiki]:!border-0',
    isTerminal && '[&>pre]:px-2 rounded-sm [&>pre]:py-1.5 border-0',
    padding,
    border && 'border border-border dark:border-0',
    className,
  );

  const cleanedCode = cleanCode(code);

  return (
    <div className={cn('group relative h-full w-full', parentClassName)}>
      {language === 'markdown' ? (
        <div className={cn(classNames, 'h-full overflow-auto')} {...props}>
          <MessageMarkdown content={cleanedCode} />
        </div>
      ) : (
        <HighlightedCode
          code={cleanedCode}
          language={language}
          classNames={classNames}
          showBackgroundColors={showBackgroundColors}
          {...props}
        />
      )}

      {showCopyButton && (
        <div className="absolute top-3 right-3 z-30 duration-200">
          <Hint label={copied ? 'Copied!' : 'Copy code'} side="top" align="center">
            <Button
              variant="secondary"
              size="icon"
              className={cn(
                'bg-accent p-0 backdrop-blur-sm',
                'hover:bg-accent',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2',
                'transition-all duration-200 ease-in-out',
              )}
              onClick={() => copy(cleanedCode)}
              aria-label={copied ? 'Code copied to clipboard' : 'Copy code to clipboard'}
              disabled={copied}
            >
              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-center transition-all duration-300 ease-in-out',
                  copied ? 'scale-100 opacity-100' : 'scale-0 opacity-0',
                )}
              >
                <Check className="text-primary size-4" />
              </div>
              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-center transition-all duration-300 ease-in-out',
                  copied ? 'scale-0 opacity-0' : 'scale-100 opacity-100',
                )}
              >
                <Icon.Copy className="size-4" />
              </div>
            </Button>
          </Hint>
        </div>
      )}
    </div>
  );
}

export { BetterCodeBlock, getLanguageFromFilename };
