'use client';

import React, { useState, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CsvTable } from '@/components/ui/csv-table';
import Papa from 'papaparse';
import { cn } from '@/lib/utils';
import {
    Search,
    FileSpreadsheet,
    Filter,
} from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
    DropdownMenuSeparator,
    DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';

interface CsvRendererProps {
    content: string;
    className?: string;
}

type SortDirection = 'asc' | 'desc' | null;

interface SortConfig {
    column: string;
    direction: SortDirection;
}

function parseCSV(content: string) {
    if (!content) return { data: [], headers: [], meta: null };

    try {
        const results = Papa.parse(content, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: true,
        });

        let headers: string[] = [];
        if (results.meta && results.meta.fields) {
            headers = results.meta.fields || [];
        }

        return {
            headers,
            data: results.data,
            meta: results.meta
        };
    } catch (error) {
        console.error("Error parsing CSV:", error);
        return { headers: [], data: [], meta: null };
    }
}

export function CsvRenderer({
    content,
    className
}: CsvRendererProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [sortConfig, setSortConfig] = useState<SortConfig>({ column: '', direction: null });
    const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
    const [currentPage, setCurrentPage] = useState(1);
    const [rowsPerPage] = useState(50);

    const parsedData = parseCSV(content);
    const isEmpty = parsedData.data.length === 0;

    const processedData = useMemo(() => {
        let filtered = parsedData.data;

        if (searchTerm) {
            filtered = filtered.filter((row: any) =>
                Object.values(row).some(value =>
                    value != null && String(value).toLowerCase().includes(searchTerm.toLowerCase())
                )
            );
        }

        if (sortConfig.column && sortConfig.direction) {
            filtered = [...filtered].sort((a: any, b: any) => {
                const aVal = a[sortConfig.column];
                const bVal = b[sortConfig.column];

                if (aVal == null && bVal == null) return 0;
                if (aVal == null) return sortConfig.direction === 'asc' ? -1 : 1;
                if (bVal == null) return sortConfig.direction === 'asc' ? 1 : -1;

                if (typeof aVal === 'number' && typeof bVal === 'number') {
                    return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
                }

                const aStr = String(aVal).toLowerCase();
                const bStr = String(bVal).toLowerCase();

                if (aStr < bStr) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aStr > bStr) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }

        return filtered;
    }, [parsedData.data, searchTerm, sortConfig]);


    const totalPages = Math.ceil(processedData.length / rowsPerPage);
    const startIndex = (currentPage - 1) * rowsPerPage;
    const paginatedData = processedData.slice(startIndex, startIndex + rowsPerPage);

    const visibleHeaders = parsedData.headers.filter(header => !hiddenColumns.has(header));

    const handleSort = (column: string) => {
        setSortConfig(prev => {
            if (prev.column === column) {
                const newDirection = prev.direction === 'asc' ? 'desc' : prev.direction === 'desc' ? null : 'asc';
                return { column: newDirection ? column : '', direction: newDirection };
            } else {
                return { column, direction: 'asc' };
            }
        });
    };

    const toggleColumnVisibility = (column: string) => {
        setHiddenColumns(prev => {
            const newSet = new Set(prev);
            if (newSet.has(column)) {
                newSet.delete(column);
            } else {
                newSet.add(column);
            }
            return newSet;
        });
    };

    if (isEmpty) {
        return (
            <div className={cn('w-full h-full flex items-center justify-center', className)}>
                <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
                        <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <div>
                        <h3 className="text-lg font-medium text-foreground">No Data</h3>
                        <p className="text-sm text-muted-foreground">This CSV file appears to be empty or invalid.</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={cn('w-full h-full flex flex-col bg-background', className)}>
            <div className="flex-shrink-0 border-b bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <FileSpreadsheet className="h-5 w-5 text-primary" />
                        <div className='flex items-center gap-2'>
                            <h3 className="font-medium text-foreground">CSV Data</h3>
                            <p className="text-xs text-muted-foreground">
                                - {processedData.length.toLocaleString()} rows, {visibleHeaders.length} columns
                                {searchTerm && ` (filtered from ${parsedData.data.length.toLocaleString()})`}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                            Page {currentPage} of {totalPages}
                        </Badge>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="sm">
                                    <Filter className="h-4 w-4 mr-1" />
                                    Columns
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                                <div className="px-2 py-1.5 text-sm font-medium">Show/Hide Columns</div>
                                <DropdownMenuSeparator />
                                {parsedData.headers.map(header => (
                                    <DropdownMenuCheckboxItem
                                        key={header}
                                        checked={!hiddenColumns.has(header)}
                                        onCheckedChange={() => toggleColumnVisibility(header)}
                                    >
                                        {header}
                                    </DropdownMenuCheckboxItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>

                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search data..."
                        value={searchTerm}
                        onChange={(e) => {
                            setSearchTerm(e.target.value);
                            setCurrentPage(1);
                        }}
                        className="pl-9"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-hidden">
                <div className="w-full h-full overflow-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 scrollbar-track-transparent">
                    <CsvTable
                        headers={visibleHeaders}
                        data={paginatedData}
                        sortConfig={sortConfig}
                        onSort={handleSort}
                        searchTerm={searchTerm}
                        onClearSearch={() => setSearchTerm('')}
                    />
                </div>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex-shrink-0 border-t bg-muted/30 p-4">
                    <div className="flex items-center justify-between">
                        <div className="text-sm text-muted-foreground">
                            Showing {startIndex + 1} to {Math.min(startIndex + rowsPerPage, processedData.length)} of {processedData.length.toLocaleString()} rows
                        </div>

                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                                disabled={currentPage === 1}
                            >
                                Previous
                            </Button>

                            <div className="flex items-center gap-1">
                                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                                    let pageNum;
                                    if (totalPages <= 5) {
                                        pageNum = i + 1;
                                    } else if (currentPage <= 3) {
                                        pageNum = i + 1;
                                    } else if (currentPage >= totalPages - 2) {
                                        pageNum = totalPages - 4 + i;
                                    } else {
                                        pageNum = currentPage - 2 + i;
                                    }

                                    return (
                                        <Button
                                            key={pageNum}
                                            variant={currentPage === pageNum ? "default" : "outline"}
                                            size="sm"
                                            onClick={() => setCurrentPage(pageNum)}
                                            className="w-8 h-8 p-0"
                                        >
                                            {pageNum}
                                        </Button>
                                    );
                                })}
                            </div>

                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                                disabled={currentPage === totalPages}
                            >
                                Next
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
