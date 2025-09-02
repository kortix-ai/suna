'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface DocsBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'default' | 'lg';
  spacing?: 'tight' | 'default' | 'loose';
  prose?: boolean;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'none';
}

export const DocsBody = React.forwardRef<HTMLDivElement, DocsBodyProps>(
  ({
    size = 'default',
    spacing = 'default',
    prose = true,
    maxWidth = 'none',
    className,
    children,
    ...props
  }, ref) => {
    const sizeClasses = {
      sm: 'text-sm',
      default: 'text-base',
      lg: 'text-lg'
    };

    const spacingClasses = {
      tight: 'space-y-3',
      default: 'space-y-4',
      loose: 'space-y-6'
    };

    const maxWidthClasses = {
      sm: 'max-w-sm',
      md: 'max-w-md', 
      lg: 'max-w-lg',
      xl: 'max-w-xl',
      '2xl': 'max-w-2xl',
      '3xl': 'max-w-3xl',
      none: 'w-full'
    };

    const proseClasses = prose ? [
      '[&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:mb-4',
      '[&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:mb-3 [&_h2]:mt-8',
      '[&_h3]:text-xl [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-6',
      '[&_h4]:text-lg [&_h4]:font-medium [&_h4]:mb-2 [&_h4]:mt-4',
      '[&_h5]:text-base [&_h5]:font-medium [&_h5]:mb-1 [&_h5]:mt-3',
      '[&_h6]:text-sm [&_h6]:font-medium [&_h6]:mb-1 [&_h6]:mt-2',
      
      '[&_p]:leading-relaxed [&_p]:text-muted-foreground',
      '[&_p]:mb-4 [&_p:last-child]:mb-0',
      
      '[&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ul]:space-y-2',
      '[&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:mb-4 [&_ol]:space-y-2',
      '[&_li]:text-muted-foreground',
      '[&_ul_ul]:mt-2 [&_ol_ol]:mt-2',
      
      '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4',
      '[&_a:hover]:text-primary/80',
      
      '[&_code]:relative [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5',
      '[&_code]:text-sm [&_code]:font-mono [&_code]:font-medium',
      '[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:mb-4',
      '[&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_pre_code]:py-0',
      
      '[&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4',
      '[&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:mb-4',
      
      '[&_table]:w-full [&_table]:border-collapse [&_table]:mb-4',
      '[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-4 [&_th]:py-2',
      '[&_th]:text-left [&_th]:font-medium',
      '[&_td]:border [&_td]:border-border [&_td]:px-4 [&_td]:py-2',
      
      '[&_img]:rounded-lg [&_img]:mb-4 [&_img]:max-w-full [&_img]:h-auto',
      
      '[&_hr]:border-border [&_hr]:my-8',
      
      '[&_strong]:font-semibold [&_strong]:text-foreground',
      '[&_em]:italic',
      
      '[&_mark]:bg-yellow-200 [&_mark]:px-1 [&_mark]:rounded',
      'dark:[&_mark]:bg-yellow-900/50',
    ].join(' ') : '';

    return (
      <div
        ref={ref}
        className={cn(
          'leading-relaxed',
          sizeClasses[size],
          spacingClasses[spacing],
          maxWidthClasses[maxWidth],
          proseClasses,
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

DocsBody.displayName = 'DocsBody'; 