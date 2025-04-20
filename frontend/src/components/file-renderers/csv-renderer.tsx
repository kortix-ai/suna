"use client";

import { useState, useEffect, useMemo } from "react";
import { readString } from "react-papaparse";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CsvRendererProps {
  content: string;
  className?: string;
}

interface ParsedCsvData {
  data: Record<string, string>[];
  headers: string[];
  errors?: any[];
}

// Define the PapaParse result interface
interface PapaParseResult {
  data: Record<string, string>[];
  errors: { message: string; row: number }[];
  meta: {
    delimiter: string;
    linebreak: string;
    aborted: boolean;
    truncated: boolean;
    cursor: number;
    fields: string[];
  };
}

export function CsvRenderer({ content, className }: CsvRendererProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 15;

  // Parse CSV data
  const parsedData = useMemo<ParsedCsvData>(() => {
    if (!content) return { data: [], headers: [] };

    try {
      let headers: string[] = [];
      let data: Record<string, string>[] = [];
      
      readString(content, {
        header: true,
        skipEmptyLines: true,
        complete: (results: any) => {
          if (results.errors && results.errors.length > 0) {
            console.error("CSV parsing errors:", results.errors);
          }
          
          headers = results.meta.fields || [];
          data = results.data || [];
        },
        error: (error: Error) => {
          console.error("CSV parsing error:", error);
        }
      });
      
      return {
        data,
        headers,
      };
    } catch (error) {
      console.error("Failed to parse CSV:", error);
      return { data: [], headers: [] };
    }
  }, [content]);

  // Filter data based on search term
  const filteredData = useMemo(() => {
    if (!searchTerm.trim()) return parsedData.data;

    const lowerCaseSearchTerm = searchTerm.toLowerCase();
    return parsedData.data.filter((row: Record<string, string>) => {
      return Object.values(row).some((value: any) => {
        if (value === null || value === undefined) return false;
        return String(value).toLowerCase().includes(lowerCaseSearchTerm);
      });
    });
  }, [parsedData.data, searchTerm]);

  // Paginate data
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * rowsPerPage;
    return filteredData.slice(startIndex, startIndex + rowsPerPage);
  }, [filteredData, currentPage, rowsPerPage]);

  // Calculate total pages
  const totalPages = Math.max(1, Math.ceil(filteredData.length / rowsPerPage));

  // Reset to first page when search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  return (
    <div className={cn("flex flex-col h-full w-full", className)}>
      {/* Search and pagination controls */}
      <div className="flex items-center justify-between p-4 border-b">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>
        
        <div className="flex items-center gap-2 ml-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          
          <span className="text-sm text-muted-foreground min-w-[100px] text-center">
            Page {currentPage} of {totalPages}
          </span>
          
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage === totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      
      {/* Table */}
      <ScrollArea className="flex-1 w-full relative">
        <div className="min-w-full">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                {parsedData.headers.map((header, index) => (
                  <TableHead key={index} className="whitespace-nowrap">
                    {header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedData.length > 0 ? (
                paginatedData.map((row, rowIndex) => (
                  <TableRow key={rowIndex}>
                    {parsedData.headers.map((header, cellIndex) => (
                      <TableCell key={cellIndex} className={cellIndex === 0 ? "font-medium" : ""}>
                        {row[header] || ""}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={parsedData.headers.length || 1}
                    className="h-24 text-center"
                  >
                    {searchTerm ? "No results found." : "No data available."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </ScrollArea>
    </div>
  );
} 