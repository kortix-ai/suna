import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems?: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  isLoading?: boolean;
  showPageSizeSelector?: boolean;
  showJumpToPage?: boolean;
  showResultsInfo?: boolean;
  pageSizeOptions?: number[];
  position?: 'top' | 'bottom' | 'standalone';
}

export const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  isLoading = false,
  showPageSizeSelector = true,
  showJumpToPage = true,
  showResultsInfo = true,
  pageSizeOptions = [10, 20, 50, 100],
  position = 'standalone'
}) => {
  const [jumpToPageInput, setJumpToPageInput] = useState<string>('');
  if (totalPages <= 1 && !showResultsInfo && !showPageSizeSelector && position === 'standalone') return null;

  const getVisiblePages = () => {
    const delta = 1;
    const range = [];
    const rangeWithDots = [];

    rangeWithDots.push(1);

    if (currentPage - delta > 2) {
      rangeWithDots.push('...');
    }

    for (let i = Math.max(2, currentPage - delta); i <= Math.min(totalPages - 1, currentPage + delta); i++) {
      if (i !== 1 && i !== totalPages) {
        range.push(i);
      }
    }
    rangeWithDots.push(...range);

    if (currentPage + delta < totalPages - 1) {
      rangeWithDots.push('...');
    }
    
    if (totalPages > 1) {
      rangeWithDots.push(totalPages);
    }

    return rangeWithDots.filter((page, index, arr) => arr.indexOf(page) === index);
  };

  const handleJumpToPage = () => {
    const pageNum = parseInt(jumpToPageInput);
    if (pageNum >= 1 && pageNum <= totalPages) {
      onPageChange(pageNum);
      setJumpToPageInput('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleJumpToPage();
    }
  };

  const visiblePages = getVisiblePages();
  
  // Safe calculations with fallback values
  const safeCurrentPage = Number(currentPage) || 1;
  const safePageSize = Number(pageSize) || 20;
  const safeTotalItems = Number(totalItems) || 0;
  
  const startItem = (safeCurrentPage - 1) * safePageSize + 1;
  const endItem = Math.min(safeCurrentPage * safePageSize, safeTotalItems || safeCurrentPage * safePageSize);

  if (position === 'top') {
    return (
      <div className="flex flex-col space-y-3 sm:space-y-0 sm:flex-row sm:items-center sm:justify-between py-4 border-b">
        {showResultsInfo && (
          <div className="flex items-center space-x-2 text-sm text-muted-foreground">
            <span>
              Showing {startItem}-{endItem} 
              {totalItems ? ` of ${totalItems}` : ''} results
            </span>
          </div>
        )}
        <div className="flex flex-col space-y-3 sm:space-y-0 sm:flex-row sm:items-center sm:space-x-4">
          {showPageSizeSelector && onPageSizeChange && (
            <div className="flex items-center space-x-2">
              <span className="text-sm text-muted-foreground whitespace-nowrap">Show</span>
              <Select 
                value={pageSize.toString()} 
                onValueChange={(value) => onPageSizeChange(parseInt(value))}
                disabled={isLoading}
              >
                <SelectTrigger className="w-16 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((size) => (
                    <SelectItem key={size} value={size.toString()}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground whitespace-nowrap">per page</span>
            </div>
          )}
          {totalPages > 1 && (
            <div className="flex items-center space-x-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(currentPage - 1)}
                disabled={currentPage <= 1 || isLoading}
                className="h-8 px-3"
                title="Previous page"
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Prev
              </Button>
              
              <span className="text-sm text-muted-foreground px-3">
                Page {currentPage} of {totalPages}
              </span>

              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(currentPage + 1)}
                disabled={currentPage >= totalPages || isLoading}
                className="h-8 px-3"
                title="Next page"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-10 flex flex-col space-y-4 pb-4 sm:space-y-0 sm:flex-row sm:items-center sm:justify-between">
      {showResultsInfo && position === 'standalone' && (
        <div className="flex items-center space-x-2 text-sm text-muted-foreground">
          <span>
            Showing {startItem}-{endItem} 
            {totalItems ? ` of ${totalItems}` : ''} results
          </span>
        </div>
      )}
      <div className="flex flex-col space-y-4 sm:space-y-0 sm:flex-row sm:items-center sm:space-x-4">
        {showPageSizeSelector && onPageSizeChange && position === 'standalone' && (
          <div className="flex items-center space-x-2">
            <span className="text-sm text-muted-foreground whitespace-nowrap">Show</span>
            <Select 
              value={pageSize.toString()} 
              onValueChange={(value) => onPageSizeChange(parseInt(value))}
              disabled={isLoading}
            >
              <SelectTrigger className="w-16 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={size.toString()}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground whitespace-nowrap">per page</span>
          </div>
        )}
        {showJumpToPage && totalPages > 5 && (
          <div className="flex items-center space-x-2">
            <span className="text-sm text-muted-foreground whitespace-nowrap">Go to</span>
            <Input
              type="number"
              min={1}
              max={totalPages}
              value={jumpToPageInput}
              onChange={(e) => setJumpToPageInput(e.target.value)}
              onKeyPress={handleKeyPress}
              className="w-16 h-8"
              placeholder="Page"
              disabled={isLoading}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleJumpToPage}
              disabled={isLoading || !jumpToPageInput}
              className="h-8 px-2"
            >
              Go
            </Button>
          </div>
        )}
        <div className="flex items-center space-x-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(1)}
            disabled={currentPage <= 1 || isLoading || totalPages <= 1}
            className="h-8 w-8 p-0"
            title="First page"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1 || isLoading || totalPages <= 1}
            className="h-8 w-8 p-0"
            title="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {totalPages > 1 ? (
            <div className="flex items-center space-x-1">
              {visiblePages.map((page, index) => (
                <React.Fragment key={index}>
                  {page === '...' ? (
                    <div className="flex h-8 w-8 items-center justify-center">
                      <MoreHorizontal className="h-4 w-4" />
                    </div>
                  ) : (
                    <Button
                      variant={currentPage === page ? "default" : "outline"}
                      size="sm"
                      onClick={() => onPageChange(page as number)}
                      disabled={isLoading}
                      className="h-8 w-8 p-0"
                      title={`Page ${page}`}
                    >
                      {page}
                    </Button>
                  )}
                </React.Fragment>
              ))}
            </div>
          ) : (
            <div className="flex items-center px-3">
              <span className="text-sm text-muted-foreground">
                Page 1 of 1
              </span>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages || isLoading || totalPages <= 1}
            className="h-8 w-8 p-0"
            title="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(totalPages)}
            disabled={currentPage >= totalPages || isLoading || totalPages <= 1}
            className="h-8 w-8 p-0"
            title="Last page"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}; 