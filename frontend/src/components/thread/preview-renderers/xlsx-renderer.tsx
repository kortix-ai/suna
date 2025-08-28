'use client';

import React, { useState, useMemo } from 'react';
import { CsvTable } from '@/components/ui/csv-table';
import * as XLSX from 'xlsx';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ChevronDown } from 'lucide-react';

interface XlsxRendererProps {
    content: string; // Blob URL or base64 encoded XLSX content
    className?: string;
    onSheetChange?: (sheetIndex: number) => void; // Callback for sheet changes
    activeSheetIndex?: number; // Controlled sheet index
    project?: any; // Optional to allow passing from file-attachment
}

/**
 * Convert blob URL to base64 string
 */
async function blobUrlToBase64(blobUrl: string): Promise<string> {
    const response = await fetch(blobUrl);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            // Remove data:application/... prefix to get just base64
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Parse XLSX content into workbook with multiple sheets
 */
async function parseXLSX(content: string) {
    if (!content) return { sheets: [], sheetNames: [] };

    try {
        let base64Content = content;

        // If content is a blob URL, convert it to base64
        if (content.startsWith('blob:')) {
            base64Content = await blobUrlToBase64(content);
        }

        // Convert base64 to binary
        const binaryString = atob(base64Content);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Read the workbook
        const workbook = XLSX.read(bytes, { type: 'array' });
        const sheetNames = workbook.SheetNames;

        // Convert each sheet to data format
        const sheets = sheetNames.map(name => {
            const worksheet = workbook.Sheets[name];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

            if (jsonData.length === 0) return { headers: [], data: [] };

            const headers = jsonData[0] as string[];
            const data = jsonData.slice(1).map(row => {
                const rowObj: any = {};
                headers.forEach((header, index) => {
                    rowObj[header] = (row as any[])[index] || '';
                });
                return rowObj;
            });

            return { headers, data };
        });

        return { sheets, sheetNames };
    } catch (error) {
        console.error("Error parsing XLSX:", error);
        return { sheets: [], sheetNames: [] };
    }
}

/**
 * Minimal XLSX renderer with sheet switching using the CsvTable component
 */
export function XlsxRenderer({
    content,
    className,
    onSheetChange,
    activeSheetIndex = 0
}: XlsxRendererProps) {
    const [internalSheetIndex, setInternalSheetIndex] = useState(0);
    const [parsedData, setParsedData] = useState<{ sheets: { headers: string[]; data: any[]; }[]; sheetNames: string[]; }>({ sheets: [], sheetNames: [] });
    const [isLoading, setIsLoading] = useState(true);
    const [sortConfig, setSortConfig] = useState<{ column: string; direction: 'asc' | 'desc' | null }>({
        column: '',
        direction: null
    });

    // Use controlled or internal sheet index
    const currentSheetIndex = onSheetChange ? activeSheetIndex : internalSheetIndex;

    // Parse XLSX content on mount or content change
    React.useEffect(() => {
        if (!content) {
            setParsedData({ sheets: [], sheetNames: [] });
            setIsLoading(false);
            return;
        }

        setIsLoading(true);
        parseXLSX(content)
            .then(result => {
                setParsedData(result);
                setIsLoading(false);
            })
            .catch(error => {
                console.error('Failed to parse XLSX:', error);
                setParsedData({ sheets: [], sheetNames: [] });
                setIsLoading(false);
            });
    }, [content]);

    const { sheets, sheetNames } = parsedData;
    const currentSheet = sheets[currentSheetIndex] || { headers: [], data: [] };
    const isEmpty = sheets.length === 0 || currentSheet.data.length === 0;

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
    const sortedData = useMemo(() => {
        if (!sortConfig.column || !sortConfig.direction) {
            return currentSheet.data;
        }

        return [...currentSheet.data].sort((a: any, b: any) => {
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
    }, [currentSheet.data, sortConfig]);

    if (isLoading) {
        return (
            <div className={cn('w-full h-full flex items-center justify-center', className)}>
                <div className="text-muted-foreground text-sm">Loading...</div>
            </div>
        );
    }

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
                headers={currentSheet.headers}
                data={sortedData}
                sortConfig={sortConfig}
                onSort={handleSort}
                containerHeight={300} // Fixed height for thread preview
            />
        </div>
    );
}