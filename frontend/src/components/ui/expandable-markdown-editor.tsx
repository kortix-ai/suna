import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "./textarea";
import { cn } from "@/lib/utils";
import { Edit2, Expand, Save, X } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ExpandableMarkdownEditorProps {
  value: string;
  onSave: (value: string) => void;
  className?: string;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
}

export const ExpandableMarkdownEditor: React.FC<ExpandableMarkdownEditorProps> = ({ 
  value, 
  onSave, 
  className = '', 
  placeholder = 'Click to edit...',
  title = 'Edit Instructions',
  disabled = false
}) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);

  useEffect(() => {
    setEditValue(value);
  }, [value]);

  const handleSave = () => {
    onSave(editValue);
    setIsEditing(false);
    setIsDialogOpen(false);
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleCancel();
    } else if (e.key === 'Enter' && e.metaKey) {
      handleSave();
    }
  };

  const openDialog = () => {
    setIsDialogOpen(true);
    setIsEditing(false);
  };

  const startEditing = () => {
    setIsEditing(true);
  };

  const renderMarkdown = (content: string, isPreview = false) => (
    <ReactMarkdown 
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="text-2xl font-bold mb-4 text-foreground">{children}</h1>,
        h2: ({ children }) => <h2 className="text-xl font-semibold mb-3 text-foreground">{children}</h2>,
        h3: ({ children }) => <h3 className="text-lg font-semibold mb-2 text-foreground">{children}</h3>,
        h4: ({ children }) => <h4 className="text-base font-semibold mb-2 text-foreground">{children}</h4>,
        h5: ({ children }) => <h5 className="text-sm font-semibold mb-2 text-foreground">{children}</h5>,
        h6: ({ children }) => <h6 className="text-sm font-medium mb-2 text-foreground">{children}</h6>,
        p: ({ children }) => <p className="mb-4 last:mb-0 text-foreground leading-relaxed">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-inside mb-4 space-y-2 text-foreground">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside mb-4 space-y-2 text-foreground">{children}</ol>,
        li: ({ children }) => <li className="text-foreground leading-relaxed">{children}</li>,
        code: ({ children, className }) => {
          const isInline = !className?.includes('language-');
          return isInline ? (
            <code className="bg-muted px-2 py-1 rounded text-sm font-mono text-foreground">{children}</code>
          ) : (
            <code className={cn('block bg-muted p-4 rounded text-sm font-mono overflow-x-auto', className)}>
              {children}
            </code>
          );
        },
        pre: ({ children }) => <pre className="bg-muted p-4 rounded text-sm font-mono overflow-x-auto mb-4">{children}</pre>,
        blockquote: ({ children }) => <blockquote className="border-l-4 border-muted-foreground/30 pl-6 italic mb-4 text-muted-foreground">{children}</blockquote>,
        strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
        em: ({ children }) => <em className="italic text-foreground">{children}</em>,
        hr: () => <hr className="my-6 border-muted-foreground/20" />,
        table: ({ children }) => (
          <div className="overflow-x-auto mb-4">
            <table className="min-w-full border-collapse border border-muted-foreground/20">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-muted-foreground/20 px-3 py-2 bg-muted font-semibold text-left text-sm">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-muted-foreground/20 px-3 py-2 text-sm">
            {children}
          </td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );

  return (
    <>
      <div className={cn('relative', className)}>
        <div 
          className="group h-full relative pb-4 border rounded-2xl bg-muted/30 hover:opacity-80 transition-colors cursor-pointer overflow-hidden"
          onClick={openDialog}
        >
          <div className="p-4 h-full overflow-hidden">
            {value ? (
              <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                {renderMarkdown(value, true)}
              </div>
            ) : (
              <div className="text-muted-foreground italic text-sm">
                {placeholder}
              </div>
            )}
          </div>
          {value && value.length > 600 && (
            <div className="absolute bottom-2 left-4 text-xs text-muted-foreground/60 z-10">
              .........
            </div>
          )}
          <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
            <Button
              size="sm"
              className="h-6 w-6 p-0 shadow-sm"
              onClick={(e) => {
                e.stopPropagation();
                openDialog();
              }}
            >
              <Expand className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-6xl max-h-[90vh] w-[98vw] md:w-full flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span className="text-lg font-semibold">{title}</span>
              {!isEditing && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={startEditing}
                  className="h-8 px-3"
                >
                  <Edit2 className="h-3 w-3 mr-1" />
                  Edit
                </Button>
              )}
            </DialogTitle>
          </DialogHeader>
          
          <div className="flex-1 overflow-hidden min-h-0">
            {isEditing ? (
              <div className="h-full flex flex-col gap-3">
                <ScrollArea className="flex-1 h-[70vh]">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="w-full h-[70vh] rounded-xl bg-muted/30 p-6 resize-none text-sm leading-relaxed font-mono"
                    style={{ minHeight: '60vh' }}
                    disabled={disabled}
                    placeholder="Write your markdown content here..."
                  />
                </ScrollArea>
                <div className="text-xs text-muted-foreground/60 flex-shrink-0 px-2">
                  Markdown supported • <kbd className="bg-muted px-1 py-0.5 rounded text-xs">⌘+Enter</kbd> to save • <kbd className="bg-muted px-1 py-0.5 rounded text-xs">Esc</kbd> to cancel
                </div>
              </div>
            ) : (
              <ScrollArea className="flex-1 h-[70vh]">
                <div className="pr-6 py-2">
                  {value ? (
                    <div className="prose prose-base dark:prose-invert max-w-none leading-relaxed">
                      {renderMarkdown(value)}
                    </div>
                  ) : (
                    <div className="text-muted-foreground italic text-center py-12 text-base">
                      {placeholder}
                    </div>
                  )}
                </div>
              </ScrollArea>
            )}
          </div>

          {isEditing && (
            <DialogFooter className="flex-shrink-0 pt-4 border-t border-border/50">
              <Button
                size="default"
                variant="outline"
                onClick={handleCancel}
                className="h-9 px-4"
              >
                <X className="h-3 w-3 mr-1" />
                Cancel
              </Button>
              <Button
                size="default"
                variant="default"
                onClick={handleSave}
                className="h-9 px-4"
              >
                <Save className="h-3 w-3 mr-1" />
                Save Changes
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}; 