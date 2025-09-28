'use client';

import React from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { UploadedFile } from './chat-input';

interface UploadedFilesDisplayProps {
  uploadedFiles: UploadedFile[];
  sandboxId?: string;
  onRemoveFile: (index: number) => void;
}

export const UploadedFilesDisplay: React.FC<UploadedFilesDisplayProps> = ({
  uploadedFiles,
  sandboxId,
  onRemoveFile,
}) => {
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (uploadedFiles.length === 0) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className="mb-2 overflow-hidden"
      >
        <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto px-3">
          {uploadedFiles.map((file, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.15 }}
              className={cn(
                'px-2 py-1 bg-muted rounded-md flex items-center gap-1.5 group text-sm',
                !sandboxId ? 'border-blue-200 dark:border-blue-800' : '',
              )}
            >
              <span className="truncate max-w-[120px] text-gray-700 dark:text-gray-300">
                {file.name}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                ({formatFileSize(file.size)})
                {!sandboxId && (
                  <span className="ml-1 text-blue-500">(pending)</span>
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-4 w-4 rounded-full p-0 hover:bg-gray-200 dark:hover:bg-gray-700"
                onClick={() => onRemoveFile(index)}
              >
                <X className="h-3 w-3" />
              </Button>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
