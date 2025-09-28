'use client';

import React, { useState } from 'react';
import { CsvTable } from '@/components/ui/csv-table';
import Papa from 'papaparse';
import { cn } from '@/lib/utils';

interface CsvRendererProps {
    content: string;
    className?: string;
    project?: any; // Optional to allow passing from file-attachment
}

/**
 * Parse CSV content into a data structure with headers and rows
 */
function parseCSV(content: string) {
    if (!content) return { data: [], headers: [] };

    try {
        const results = Papa.parse(content, {
            header: true,
            skipEmptyLines: true
        });

        let headers: string[] = [];
        if (results.meta && results.meta.fields) {
            headers = results.meta.fields || [];
        }

        return { headers, data: results.data };
    } catch (error) {
        console.error("Error parsing CSV:", error);
        return { headers: [], data: [] };
    }
}

/**
 * Minimal CSV renderer for thread previews using the CsvTable component
 */
export function CsvRenderer({
    content,
    className
}: CsvRendererProps) {
    const [sortConfig, setSortConfig] = useState<{ column: string; direction: 'asc' | 'desc' | null }>({
        column: '',
        direction: null
    });

    const parsedData = parseCSV(content);
    const isEmpty = parsedData.data.length === 0;

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

    // Sort the data based on sortConfig
    const sortedData = React.useMemo(() => {
        if (!sortConfig.column || !sortConfig.direction) {
            return parsedData.data;
        }

        return [...parsedData.data].sort((a: any, b: any) => {
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
    }, [parsedData.data, sortConfig]);

    if (isEmpty) {
        return (
            <div className={cn('w-full h-full flex items-center justify-center', className)}>
                <div className="text-muted-foreground text-sm">No data</div>
            </div>
        );
    }

    return (
        <div className={cn('w-full h-full', className)}>
            <CsvTable
                headers={parsedData.headers}
                data={sortedData}
                sortConfig={sortConfig}
                onSort={handleSort}
                containerHeight={300} // Fixed height for thread preview
            />
        </div>
    );
} 