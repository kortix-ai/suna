'use client';

import React, { useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { ChevronDownIcon, LayoutGridIcon, Plus } from 'lucide-react';
import { useEditorStore } from '@/lib/stores/use-editor-store';

interface TableDropdownProps {
  setDropdownOpen: (open: boolean) => void;
}

export default function InsertTableDropdown({
  setDropdownOpen,
}: TableDropdownProps) {
  const { editor } = useEditorStore();
  const [open, setOpen] = useState(false);

  const [maxRows, setMaxRows] = useState(5);
  const [maxCols, setMaxCols] = useState(5);
  const [selectedRows, setSelectedRows] = useState(0);
  const [selectedCols, setSelectedCols] = useState(0);

  const cellSize = 24;
  const cellStyle = {
    width: cellSize,
    height: cellSize,
    border: '1px solid #ccc',
    margin: 1,
    cursor: 'pointer',
  };

  const handleMouseEnterCell = (row: number, col: number) => {
    setSelectedRows(row + 1);
    setSelectedCols(col + 1);
  };

  const handleCellClick = () => {
    if (editor && selectedRows > 0 && selectedCols > 0) {
      editor
        .chain()
        .focus()
        .insertTable({
          rows: selectedRows,
          cols: selectedCols,
          withHeaderRow: true,
        })
        .run();
    }
    setOpen(false);
    setDropdownOpen(false);
  };

  const expandColumns = () => {
    setMaxCols((prev) => prev + 1);
  };

  const expandRows = () => {
    setMaxRows((prev) => prev + 1);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        setDropdownOpen(isOpen);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="flex items-center gap-1 h-8"
        >
          <LayoutGridIcon className="h-4 w-4" />
          <ChevronDownIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="p-2">
        <div className="flex flex-col">
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${maxCols}, ${cellSize}px)`,
              }}
            >
              {Array.from({ length: maxRows }).map((_, rowIndex) =>
                Array.from({ length: maxCols }).map((_, colIndex) => {
                  const isSelected =
                    rowIndex < selectedRows && colIndex < selectedCols;
                  return (
                    <div
                      key={`${rowIndex}-${colIndex}`}
                      style={{
                        ...cellStyle,
                        backgroundColor: isSelected ? '#bde4ff' : 'transparent',
                      }}
                      onMouseEnter={() =>
                        handleMouseEnterCell(rowIndex, colIndex)
                      }
                      onClick={handleCellClick}
                    />
                  );
                }),
              )}
            </div>
            <div
              style={{
                position: 'absolute',
                left: -30,
                top: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <Button
                size="sm"
                variant="outline"
                onClick={expandColumns}
                style={{ marginBottom: 2 }}
              >
                <Plus size={16} />
              </Button>
            </div>
            <div
              style={{
                position: 'absolute',
                left: 0,
                bottom: -30,
              }}
            >
              <Button size="sm" variant="outline" onClick={expandRows}>
                <Plus size={16} />
              </Button>
            </div>
          </div>
          <div className="mt-2 text-sm">
            {selectedRows} x {selectedCols} Table
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
