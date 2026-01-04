import { useEffect, useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "./textarea";
import { cn } from "@/lib/utils";
import { Edit2, Expand, Save, X } from "lucide-react";
import { UnifiedMarkdown } from "@/components/markdown";

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
    if (disabled) return;
    setIsDialogOpen(true);
    setIsEditing(false);
  };

  const startEditing = () => {
    if (disabled) return;
    setIsEditing(true);
  };

  const renderMarkdown = (content: string) => (
    <UnifiedMarkdown content={content} />
  );

  return (
    <>
      <div className={cn('relative', className)}>
        <div
          className={cn(
            "group h-full relative pb-4 border rounded-2xl bg-muted/30 transition-colors overflow-hidden",
            disabled
              ? "cursor-not-allowed opacity-60"
              : "hover:opacity-80 cursor-pointer"
          )}
          onClick={openDialog}
        >
          <div className="p-4 h-full overflow-hidden">
            {value ? (
              <div className="text-sm">
                {renderMarkdown(value)}
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
          {!disabled && (
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
          )}
        </div>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-6xl max-h-[90vh] w-[98vw] md:w-full flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span className="text-lg font-semibold">{title}</span>
              {!isEditing && !disabled && (
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
                    className="w-full h-[70vh] rounded-2xl bg-muted/30 p-6 resize-none text-sm leading-relaxed font-mono"
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
                    <div>
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