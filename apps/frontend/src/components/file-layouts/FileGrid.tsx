/**
 * FileGrid - Grid layout for multiple files
 */

import { cn } from '@/lib/utils';
import { isPreviewableFile } from '@/lib/utils/file-types';

export interface FileGridProps {
    files: string[];
    children: (filepath: string, index: number) => React.ReactNode;
    className?: string;
}

export function FileGrid({
    files,
    children,
    className,
}: FileGridProps) {
    // Separate previewable files from compact files
    const compactFiles = files.filter(file => !isPreviewableFile(file));
    const previewableFiles = files.filter(file => isPreviewableFile(file));
    
    return (
        <div className={cn("flex flex-col gap-3 isolate", className)}>
            {/* Compact files - flex wrap */}
            {compactFiles.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {compactFiles.map((file, index) => (
                        <div
                            key={`compact-${index}`}
                            className="relative group overflow-visible flex-1 min-w-full sm:min-w-[180px] max-w-full"
                        >
                            {children(file, files.indexOf(file))}
                        </div>
                    ))}
                </div>
            )}
            
            {/* Previewable files each on their own row */}
            {previewableFiles.map((file, index) => (
                <div
                    key={`preview-${index}`}
                    className="relative group overflow-visible w-full"
                >
                    {children(file, files.indexOf(file))}
                </div>
            ))}
        </div>
    );
}

