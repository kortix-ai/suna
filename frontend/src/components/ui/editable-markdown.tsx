import { useEffect, useState } from "react";
import { Textarea } from "./textarea";
import { cn } from "@/lib/utils";
import { Edit2 } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
          <ReactMarkdown 
            remarkPlugins={[remarkGfm]}
            components={{
              // Custom styling for markdown elements
              h1: ({ children }) => <h1 className="text-lg font-semibold mb-2">{children}</h1>,
              h2: ({ children }) => <h2 className="text-base font-semibold mb-2">{children}</h2>,
              h3: ({ children }) => <h3 className="text-sm font-semibold mb-1">{children}</h3>,
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
              li: ({ children }) => <li className="text-sm">{children}</li>,
              code: ({ children, className }) => {
                const isInline = !className?.includes('language-');
                return isInline ? (
                  <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{children}</code>
                ) : (
                  <code className={cn('block bg-muted p-2 rounded text-xs font-mono overflow-x-auto', className)}>
                    {children}
                  </code>
                );
              },
              pre: ({ children }) => <pre className="bg-muted p-2 rounded text-xs font-mono overflow-x-auto mb-2">{children}</pre>,
              blockquote: ({ children }) => <blockquote className="border-l-4 border-muted-foreground/20 pl-4 italic mb-2">{children}</blockquote>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              em: ({ children }) => <em className="italic">{children}</em>,
              hr: () => <hr className="my-4 border-muted-foreground/20" />,
              table: ({ children }) => (
                <div className="overflow-x-auto">
                  <table className="min-w-full border-collapse border border-muted-foreground/20 mb-2">
                    {children}
                  </table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border border-muted-foreground/20 px-2 py-1 bg-muted font-semibold text-left text-xs">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="border border-muted-foreground/20 px-2 py-1 text-xs">
                  {children}
                </td>
              ),
            }}
          >
            {value}
          </ReactMarkdown>
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