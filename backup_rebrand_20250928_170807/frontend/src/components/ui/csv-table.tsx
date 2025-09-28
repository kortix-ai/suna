'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import {
    ChevronUp,
    ChevronDown,
    ArrowUpDown,
} from 'lucide-react';

interface CsvTableProps {
    headers: string[];
    data: any[];
    sortConfig: { column: string; direction: 'asc' | 'desc' | null };
    onSort: (column: string) => void;
    searchTerm?: string;
    onClearSearch?: () => void;
    className?: string;
    containerHeight?: number; // Add container height prop
}

export function CsvTable({
    headers,
    data,
    sortConfig,
    onSort,
    searchTerm,
    onClearSearch,
    className,
    containerHeight = 500
}: CsvTableProps) {
    const { resolvedTheme } = useTheme();
    const ROW_HEIGHT = 48; // Height of each row in pixels
    const HEADER_HEIGHT = 48; // Height of header row
    const COL_WIDTH = 150; // Fixed column width in pixels

    // Calculate offset to handle parent containers with fractional heights like calc(100vh-17rem)
    // 17rem = 272px (16px base * 17), so we need to offset the grid to align properly
    const parentOffset = 272; // 17rem in pixels
    const gridOffsetY = parentOffset % ROW_HEIGHT; // Get remainder to align to 48px grid

    // Theme-aware grid colors with subtle monochrome grays
    const getGridColors = () => {
        const isDark = resolvedTheme === 'dark';
        return {
            vertical: isDark ? 'rgb(64 64 64)' : 'rgb(229 229 229)', // Subtle gray for each theme
            horizontal: isDark ? 'rgb(64 64 64)' : 'rgb(229 229 229)', // Same for consistency
            background: 'hsl(var(--muted))'
        };
    };

    const gridColors = getGridColors();
    const getSortIcon = (column: string) => {
        if (sortConfig.column !== column) {
            return <ArrowUpDown className="h-3 w-3 text-muted-foreground" />;
        }
        return sortConfig.direction === 'asc' ?
            <ChevronUp className="h-3 w-3 text-primary" /> :
            <ChevronDown className="h-3 w-3 text-primary" />;
    };

    const formatCellValue = (value: any) => {
        if (value == null) return '';
        if (typeof value === 'number') {
            return value.toLocaleString();
        }
        if (typeof value === 'boolean') {
            return value ? 'Yes' : 'No';
        }
        return String(value);
    };

    const getCellClassName = (value: any) => {
        if (typeof value === 'number') {
            return 'text-right font-mono';
        }
        if (typeof value === 'boolean') {
            return value ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
        }
        return '';
    };

    return (
        <div className={cn("w-full relative h-full !bg-card", className)}>
            {/* Use CSS Grid for perfect alignment */}
            <div
                className="w-full h-full overflow-auto relative min-h-full"
                style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${headers.length}, 150px)`,
                    gridAutoRows: '48px',
                    minHeight: '100%',
                    backgroundColor: gridColors.background,
                    backgroundImage: `
                        repeating-linear-gradient(
                            to right,
                            transparent 0px,
                            transparent 149px,
                            ${gridColors.vertical} 149px,
                            ${gridColors.vertical} 150px
                        ),
                        repeating-linear-gradient(
                            to bottom,
                            transparent 0px,
                            transparent 47px,
                            ${gridColors.horizontal} 47px,
                            ${gridColors.horizontal} 48px
                        )
                    `,
                    backgroundSize: `${(headers.length - 1) * 150 + 149}px 48px, 150px 48px`,
                    backgroundPosition: '0 0',
                    backgroundAttachment: 'local'
                } as React.CSSProperties}
            >
                {/* Header background extension for infinite grid */}
                <div
                    className={cn(
                        "sticky top-0 z-10 pointer-events-none",
                        resolvedTheme === 'dark' ? 'bg-muted' : 'bg-background'
                    )}
                    style={{
                        position: 'absolute',
                        left: `${headers.length * 150}px`,
                        right: 0,
                        height: '48px',
                        top: 0
                    }}
                />
                {/* Header row */}
                {headers.map((header, index) => (
                    <div
                        key={`header-${index}`}
                        className={cn(
                            "sticky top-0 z-20 flex items-center px-4 font-medium",
                            resolvedTheme === 'dark' ? 'bg-muted' : 'bg-background'
                        )}
                        style={{
                            gridColumn: index + 1,
                            gridRow: 1,
                            height: '48px'
                        }}
                    >
                        <button
                            onClick={() => onSort(header)}
                            className="flex items-center gap-2 hover:text-primary transition-colors group w-full text-left"
                        >
                            <span className="truncate">{header}</span>
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                {getSortIcon(header)}
                            </div>
                        </button>
                    </div>
                ))}

                {/* Data rows */}
                {data.map((row: any, rowIndex) => (
                    headers.map((header, cellIndex) => {
                        const value = row[header];
                        return (
                            <div
                                key={`${rowIndex}-${cellIndex}`}
                                className={cn(
                                    "flex items-center px-4 text-sm hover:bg-muted/30 transition-colors",
                                    getCellClassName(value)
                                )}
                                style={{
                                    gridColumn: cellIndex + 1,
                                    gridRow: rowIndex + 2,
                                    height: '48px'
                                }}
                            >
                                <div className="truncate w-full" title={String(value || '')}>
                                    {formatCellValue(value)}
                                </div>
                            </div>
                        );
                    })
                ))}

                {/* Empty state for search */}
                {data.length === 0 && searchTerm && (
                    <div
                        className="col-span-full py-8 text-center text-muted-foreground"
                        style={{
                            gridColumn: `1 / ${headers.length + 1}`,
                            gridRow: 2
                        }}
                    >
                        <div className="space-y-2">
                            <p>No results found for "{searchTerm}"</p>
                            {onClearSearch && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={onClearSearch}
                                >
                                    Clear search
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
