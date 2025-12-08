'use client';

import React, { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { CsvTable } from '@/components/ui/csv-table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/components/AuthProvider';
import { fetchFileContent } from '@/hooks/files/use-file-queries';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  Search,
  FileSpreadsheet,
  Filter,
  ChevronDown,
} from 'lucide-react';

interface XlsxRendererProps {
  content?: string | null;
  filePath?: string;
  fileName: string;
  className?: string;
  sandboxId?: string;
  project?: {
    sandbox?: {
      id?: string;
      sandbox_url?: string;
    };
  };
  onDownload?: () => void;
  isDownloading?: boolean;
}

type FileFormat = 'xlsx' | 'xls' | 'unknown';

/**
 * Detect Excel file format from magic bytes
 */
function detectExcelFormat(buffer: ArrayBuffer): FileFormat {
  const view = new Uint8Array(buffer);
  
  // XLSX/ZIP signature: PK (0x50 0x4B 0x03 0x04)
  if (view.length >= 4 && view[0] === 0x50 && view[1] === 0x4B && view[2] === 0x03 && view[3] === 0x04) {
    return 'xlsx';
  }
  
  // XLS/OLE signature: D0 CF 11 E0 A1 B1 1A E1
  if (view.length >= 8 && 
      view[0] === 0xD0 && view[1] === 0xCF && view[2] === 0x11 && view[3] === 0xE0 &&
      view[4] === 0xA1 && view[5] === 0xB1 && view[6] === 0x1A && view[7] === 0xE1) {
    return 'xls';
  }
  
  return 'unknown';
}

interface ParsedWorkbook {
  sheets: { headers: string[]; data: Record<string, any>[] }[];
  sheetNames: string[];
}

/**
 * Parse XLSX format using read-excel-file (no vulnerabilities)
 */
async function parseXlsxFormat(file: File): Promise<ParsedWorkbook> {
  const readXlsxFile = (await import('read-excel-file')).default;
  const readSheetNames = (await import('read-excel-file')).readSheetNames;

  const sheetNames = await readSheetNames(file);
  
  const sheets = await Promise.all(
    sheetNames.map(async (sheetName) => {
      try {
        const rows = await readXlsxFile(file, { sheet: sheetName });
        
        if (!rows || rows.length === 0) {
          return { headers: [], data: [] };
        }
        
        const headers = rows[0].map((h, idx) => 
          h == null || h === '' ? `Column ${idx + 1}` : String(h)
        );
        
        const data = rows.slice(1).map((row) => {
          const obj: Record<string, any> = {};
          headers.forEach((header, i) => {
            let value = row[i];
            if (value instanceof Date) {
              value = value.toLocaleDateString();
            }
            obj[header] = value ?? '';
          });
          return obj;
        });
        
        return { headers, data };
      } catch (err) {
        console.error(`[XlsxRenderer] Error parsing sheet "${sheetName}":`, err);
        return { headers: [], data: [] };
      }
    })
  );
  
  return { sheets, sheetNames };
}

/**
 * Parse XLS (old Excel format) using xlsx library
 * Note: xlsx has known vulnerabilities but is the only option for XLS files
 */
async function parseXlsFormat(arrayBuffer: ArrayBuffer): Promise<ParsedWorkbook> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  
  const sheetNames: string[] = workbook.SheetNames || [];
  
  const sheets = sheetNames.map((name) => {
    const ws = workbook.Sheets[name];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
    
    if (!rows || rows.length === 0) {
      return { headers: [], data: [] };
    }
    
    const headers = (rows[0] as any[]).map((h, idx) => 
      h == null || h === '' ? `Column ${idx + 1}` : String(h)
    );
    
    const data = rows.slice(1).map((row) => {
      const obj: Record<string, any> = {};
      headers.forEach((header, i) => {
        obj[header] = (row as any[])[i] ?? '';
      });
      return obj;
    });
    
    return { headers, data };
  });
  
  return { sheets, sheetNames };
}

export function XlsxRenderer({
  filePath,
  fileName,
  className,
  sandboxId,
  project
}: XlsxRendererProps) {
  const { session } = useAuth();
  const [sheetIndex, setSheetIndex] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage] = useState(50);
  const [sortConfig, setSortConfig] = useState<{ column: string; direction: 'asc' | 'desc' | null }>({ column: '', direction: null });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedWorkbook>({ sheets: [], sheetNames: [] });

  const xlsxPath = filePath || fileName;
  const resolvedSandboxId = sandboxId || project?.sandbox?.id;

  React.useEffect(() => {
    let cancelled = false;
    
    async function load() {
      try {
        setIsLoading(true);
        setError(null);
        setHiddenColumns(new Set());
        setCurrentPage(1);
        setSortConfig({ column: '', direction: null });
        setSheetIndex(0);

        let arrayBuffer: ArrayBuffer;
        
        if (typeof xlsxPath === 'string' && xlsxPath.startsWith('blob:')) {
          const resp = await fetch(xlsxPath);
          if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
          arrayBuffer = await resp.arrayBuffer();
        } else if (resolvedSandboxId && session?.access_token) {
          // Handle paths that start with "workspace" (without leading /)
          let normalizedPath = xlsxPath;
          if (xlsxPath === 'workspace' || xlsxPath.startsWith('workspace/')) {
            normalizedPath = '/' + xlsxPath;
          } else if (!xlsxPath.startsWith('/workspace')) {
            normalizedPath = `/workspace/${xlsxPath.startsWith('/') ? xlsxPath.substring(1) : xlsxPath}`;
          }
          
          const url = new URL(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${resolvedSandboxId}/files/content`);
          url.searchParams.append('path', normalizedPath);
          
          const response = await fetch(url.toString(), {
            headers: {
              'Authorization': `Bearer ${session.access_token}`,
            },
          });
          
          if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status}`);
          }
          
          arrayBuffer = await response.arrayBuffer();
        } else {
          const resp = await fetch(xlsxPath);
          if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
          arrayBuffer = await resp.arrayBuffer();
        }

        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error('Empty file received');
        }

        // Detect file format
        const format = detectExcelFormat(arrayBuffer);
        console.log('[XlsxRenderer] Detected format:', format, 'size:', arrayBuffer.byteLength);

        let result: ParsedWorkbook;
        
        if (format === 'xlsx') {
          // Use read-excel-file for XLSX (modern format, no vulnerabilities)
          const file = new File([arrayBuffer], fileName || 'spreadsheet.xlsx', { 
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
          });
          result = await parseXlsxFormat(file);
        } else if (format === 'xls') {
          // Use xlsx library for XLS (old format, required for compatibility)
          result = await parseXlsFormat(arrayBuffer);
        } else {
          throw new Error('Unknown file format. Expected XLS or XLSX file.');
        }

        if (!cancelled) {
          setParsed(result);
          setIsLoading(false);
        }
      } catch (e: any) {
        console.error('[XlsxRenderer] Parse error:', e);
        if (!cancelled) {
          setError(e?.message || 'Failed to load spreadsheet');
          setParsed({ sheets: [], sheetNames: [] });
          setIsLoading(false);
        }
      }
    }
    
    load();
    return () => { cancelled = true; };
  }, [xlsxPath, resolvedSandboxId, session?.access_token, fileName]);

  const currentSheet = parsed.sheets[sheetIndex] || { headers: [], data: [] };

  const processedData = useMemo(() => {
    let filtered = currentSheet.data;
    if (searchTerm) {
      filtered = filtered.filter((row: any) =>
        Object.entries(row)
          .filter(([key]) => !hiddenColumns.has(key))
          .some(([, value]) => value != null && String(value).toLowerCase().includes(searchTerm.toLowerCase()))
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
  }, [currentSheet.data, searchTerm, sortConfig, hiddenColumns]);

  const totalPages = Math.ceil(processedData.length / rowsPerPage) || 1;
  const startIndex = (currentPage - 1) * rowsPerPage;
  const paginatedData = processedData.slice(startIndex, startIndex + rowsPerPage);
  const visibleHeaders = currentSheet.headers.filter((h) => !hiddenColumns.has(h));

  const handleSort = (column: string) => {
    setSortConfig((prev) => {
      if (prev.column === column) {
        const next = prev.direction === 'asc' ? 'desc' : prev.direction === 'desc' ? null : 'asc';
        return { column: next ? column : '', direction: next };
      }
      return { column, direction: 'asc' };
    });
  };

  const toggleColumnVisibility = (column: string) => {
    setHiddenColumns((prev) => {
      const s = new Set(prev);
      if (s.has(column)) s.delete(column); else s.add(column);
      return s;
    });
  };

  if (isLoading) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (error || (parsed.sheets.length === 0 || currentSheet.data.length === 0)) {
    return (
      <div className={cn('w-full h-full flex items-center justify-center', className)}>
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-full bg-muted flex items-center justify-center">
            <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-foreground">{error ? 'Failed to load spreadsheet' : 'No Data'}</h3>
            {!error && <p className="text-sm text-muted-foreground">This sheet appears to be empty.</p>}
            {error && <p className="text-xs text-muted-foreground">{error}</p>}
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
              <h3 className="font-medium text-foreground">Spreadsheet</h3>
              <p className="text-xs text-muted-foreground">
                - {processedData.length.toLocaleString()} rows, {visibleHeaders.length} columns
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {parsed.sheetNames.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <ChevronDown className="h-4 w-4 mr-1" />
                    {parsed.sheetNames[sheetIndex] || 'Sheet 1'}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  {parsed.sheetNames.map((name, i) => (
                    <DropdownMenuItem
                      key={name + i}
                      onClick={() => {
                        setSheetIndex(i);
                        setHiddenColumns(new Set());
                        setCurrentPage(1);
                        setSortConfig({ column: '', direction: null });
                      }}
                      className="cursor-pointer"
                    >
                      {name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

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
                {currentSheet.headers.map((h) => (
                  <DropdownMenuCheckboxItem
                    key={h}
                    checked={!hiddenColumns.has(h)}
                    onCheckedChange={() => toggleColumnVisibility(h)}
                  >
                    {h}
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
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum;
                  if (totalPages <= 5) pageNum = i + 1;
                  else if (currentPage <= 3) pageNum = i + 1;
                  else if (currentPage >= totalPages - 2) pageNum = totalPages - 4 + i;
                  else pageNum = currentPage - 2 + i;
                  return (
                    <Button
                      key={pageNum}
                      variant={currentPage === pageNum ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setCurrentPage(pageNum as number)}
                      className="w-8 h-8 p-0"
                    >
                      {pageNum as number}
                    </Button>
                  );
                })}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
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
