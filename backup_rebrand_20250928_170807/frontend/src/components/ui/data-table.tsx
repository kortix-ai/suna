'use client';

import * as React from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export interface DataTableColumn<T> {
  id: string;
  header: string;
  accessorKey?: keyof T;
  cell?: (item: T) => React.ReactNode;
  className?: string;
  headerClassName?: string;
  width?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  className?: string;
  emptyMessage?: string;
  onRowClick?: (item: T) => void;
  selectable?: boolean;
  selectedItems?: T[];
  onSelectionChange?: (selectedItems: T[]) => void;
  getItemId?: (item: T) => string;
  headerActions?: React.ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  className,
  emptyMessage = 'No data available',
  onRowClick,
  selectable = false,
  selectedItems = [],
  onSelectionChange,
  getItemId,
  headerActions,
}: DataTableProps<T>) {
  const isAllSelected = selectable && data.length > 0 && selectedItems.length === data.length;
  const isSomeSelected = selectable && selectedItems.length > 0 && selectedItems.length < data.length;

  const handleSelectAll = () => {
    if (!selectable || !onSelectionChange) return;
    
    if (isAllSelected) {
      onSelectionChange([]);
    } else {
      onSelectionChange(data);
    }
  };

  const handleSelectItem = (item: T) => {
    if (!selectable || !onSelectionChange || !getItemId) return;
    
    const itemId = getItemId(item);
    const isSelected = selectedItems.some(selectedItem => getItemId(selectedItem) === itemId);
    
    if (isSelected) {
      onSelectionChange(selectedItems.filter(selectedItem => getItemId(selectedItem) !== itemId));
    } else {
      onSelectionChange([...selectedItems, item]);
    }
  };

  const isItemSelected = (item: T): boolean => {
    if (!selectable || !getItemId) return false;
    const itemId = getItemId(item);
    return selectedItems.some(selectedItem => getItemId(selectedItem) === itemId);
  };

  return (
    <div className={cn('rounded-md border', className)}>
      {selectable && selectedItems.length > 0 && headerActions && (
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="text-sm text-muted-foreground">
            {selectedItems.length} item{selectedItems.length !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2">
            {headerActions}
          </div>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            {selectable && (
              <TableHead className="w-12">
                <Checkbox
                  checked={isAllSelected || isSomeSelected}
                  onCheckedChange={handleSelectAll}
                  aria-label="Select all"
                />
              </TableHead>
            )}
            {columns.map((column) => (
              <TableHead
                key={column.id}
                className={cn(column.headerClassName, column.width, 'text-muted-foreground font-semibold')}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length + (selectable ? 1 : 0)} className="text-center py-8 text-muted-foreground">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            data.map((item, index) => (
              <TableRow
                key={getItemId ? getItemId(item) : index}
                className={cn(
                  onRowClick && 'cursor-pointer hover:bg-muted/50',
                  selectable && isItemSelected(item) && 'bg-muted/50'
                )}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('[role="checkbox"]')) {
                    return;
                  }
                  onRowClick?.(item);
                }}
              >
                {selectable && (
                  <TableCell>
                    <Checkbox
                      checked={isItemSelected(item)}
                      onCheckedChange={() => handleSelectItem(item)}
                      aria-label={`Select item ${index + 1}`}
                    />
                  </TableCell>
                )}
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(column.className, column.width)}
                  >
                    {column.cell 
                      ? column.cell(item) 
                      : column.accessorKey 
                        ? String(item[column.accessorKey] || '')
                        : ''
                    }
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
} 