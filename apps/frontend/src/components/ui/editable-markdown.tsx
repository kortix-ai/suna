import { useEffect, useState } from "react";
import { Textarea } from "./textarea";
import { cn } from "@/lib/utils";
import { Edit2 } from "lucide-react";
import { UnifiedMarkdown } from "@/components/markdown";

interface EditableMarkdownProps {
  value: string;
  onSave: (value: string) => void;
  className?: string;
  placeholder?: string;
  minHeight?: string;
}

export const EditableMarkdown: React.FC<EditableMarkdownProps> = ({ 
  value, 
  onSave, 
  className = '', 
  placeholder = 'Click to edit...', 
  minHeight = '150px'
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);

  useEffect(() => {
    setEditValue(value);
  }, [value]);

  const handleSave = () => {
    onSave(editValue);
    setIsEditing(false);
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

  if (isEditing) {
    return (
      <div className={cn(
        'space-y-1',
        className?.includes('flex-1') ? 'flex flex-col h-full' : ''
      )}>
        <Textarea
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          autoFocus
          className={cn(
            'border-none shadow-none px-0 focus-visible:ring-0 bg-transparent resize-none',
            className?.includes('flex-1') ? 'flex-1' : '',
            className
          )}
          style={{
            fontSize: 'inherit',
            fontWeight: 'inherit',
            lineHeight: 'inherit',
            minHeight: className?.includes('flex-1') ? undefined : minHeight
          }}
        />
        <div className="text-xs text-muted-foreground/50 px-0 flex-shrink-0">
          Markdown supported • Cmd+Enter to save • Esc to cancel
        </div>
      </div>
    );
  }

  return (
    <div 
      className={cn(
        'group bg-transparent cursor-pointer relative rounded px-2 py-1 -mx-2 -my-1 transition-colors hover:bg-muted/50',
        className?.includes('flex-1') ? 'flex flex-col h-full' : '',
        className
      )}
      onClick={() => setIsEditing(true)}
    >
      <div 
        className={cn(
          value ? '' : 'text-muted-foreground italic',
          'prose prose-sm dark:prose-invert max-w-none',
          className?.includes('flex-1') ? 'flex-1 min-h-0' : ''
        )}
        style={{ minHeight: className?.includes('flex-1') ? undefined : minHeight }}
      >
        {value ? (
          <UnifiedMarkdown content={value} />
        ) : (
          <div className="text-muted-foreground italic" style={{ minHeight }}>
            {placeholder}
          </div>
        )}
      </div>
      <Edit2 className="h-3 w-3 opacity-0 group-hover:opacity-50 absolute top-1 right-1 transition-opacity" />
    </div>
  );
}; 