'use client';

import * as React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface DocsTableColumn {
  key: string;
  title: string;
  width?: string;
  align?: 'left' | 'center' | 'right';
  render?: (value: any, row: any, index: number) => React.ReactNode;
}

export interface DocsTableRow {
  [key: string]: any;
}

export interface DocsTableProps extends React.HTMLAttributes<HTMLDivElement> {
  columns: DocsTableColumn[];
  data: DocsTableRow[];
  size?: 'sm' | 'default' | 'lg';
  variant?: 'default' | 'striped' | 'bordered';
  caption?: string;
  showHeader?: boolean;
  stickyHeader?: boolean;
  maxHeight?: string;
}

export const DocsTable = React.forwardRef<HTMLDivElement, DocsTableProps>(
  ({
    columns,
    data,
    size = 'default',
    variant = 'default',
    caption,
    showHeader = true,
    stickyHeader = false,
    maxHeight,
    className,
    ...props
  }, ref) => {
    const sizeClasses = {
      sm: '[&_th]:px-3 [&_th]:py-2 [&_td]:px-3 [&_td]:py-2 [&_th]:text-xs [&_td]:text-sm',
      default: '[&_th]:px-4 [&_th]:py-3 [&_td]:px-4 [&_td]:py-2 [&_th]:text-sm [&_td]:text-sm',
      lg: '[&_th]:px-6 [&_th]:py-4 [&_td]:px-6 [&_td]:py-3 [&_th]:text-base [&_td]:text-base'
    };

    const variantClasses = {
      default: '',
      striped: '[&_tbody_tr:nth-child(even)]:bg-muted/20',
      bordered: 'border [&_th]:border [&_td]:border'
    };

    const getAlignmentClass = (align?: string) => {
      switch (align) {
        case 'center':
          return 'text-center';
        case 'right':
          return 'text-right';
        default:
          return 'text-left';
      }
    };

    const renderCellContent = (column: DocsTableColumn, row: DocsTableRow, rowIndex: number) => {
      const value = row[column.key];
      
      if (column.render) {
        return column.render(value, row, rowIndex);
      }

      // Default rendering for common data types
      if (typeof value === 'boolean') {
        return (
          <Badge variant={value ? 'default' : 'secondary'} className="text-xs">
            {value ? 'Yes' : 'No'}
          </Badge>
        );
      }

      if (Array.isArray(value)) {
        return (
          <div className="flex flex-wrap gap-1">
            {value.map((item, index) => (
              <Badge key={index} variant="outline" className="text-xs">
                {String(item)}
              </Badge>
            ))}
          </div>
        );
      }

      if (value === null || value === undefined) {
        return <span className="text-muted-foreground">-</span>;
      }

      return String(value);
    };

    return (
      <div
        ref={ref}
        className={cn("relative overflow-hidden rounded-lg border", className)}
        {...props}
      >
        <div 
          className="overflow-auto"
          style={{ maxHeight }}
        >
          <Table className={cn(
            sizeClasses[size],
            variantClasses[variant]
          )}>
            {caption && (
              <caption className="mt-4 text-sm text-muted-foreground">
                {caption}
              </caption>
            )}
            
            {showHeader && (
              <TableHeader className={stickyHeader ? 'sticky top-0 bg-background' : ''}>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead
                      key={column.key}
                      className={cn(
                        "font-medium",
                        getAlignmentClass(column.align)
                      )}
                      style={{ width: column.width }}
                    >
                      {column.title}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
            )}
            
            <TableBody>
              {data.length === 0 ? (
                <TableRow>
                  <TableCell 
                    colSpan={columns.length} 
                    className="text-center text-muted-foreground py-8"
                  >
                    No data available
                  </TableCell>
                </TableRow>
              ) : (
                data.map((row, rowIndex) => (
                  <TableRow key={rowIndex}>
                    {columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={getAlignmentClass(column.align)}
                      >
                        {renderCellContent(column, row, rowIndex)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }
);

DocsTable.displayName = 'DocsTable';

// Utility function to create table columns
export const createDocsTableColumn = (
  key: string,
  title: string,
  options?: Omit<DocsTableColumn, 'key' | 'title'>
): DocsTableColumn => ({
  key,
  title,
  ...options
}); 