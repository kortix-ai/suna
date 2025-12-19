import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, ExternalLink, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface SmartJsonViewerProps {
  data: any;
  name?: string; // Root name
  className?: string;
  initialExpandedDepth?: number;
  depth?: number;
}

const getType = (value: any) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
};

const ValueRenderer = ({ value }: { value: any }) => {
  const type = getType(value);

  if (type === 'null') return <span className="text-muted-foreground/60 italic">null</span>;
  if (type === 'string') {
    // URL detection
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return (
        <a 
          href={value} 
          target="_blank" 
          rel="noopener noreferrer" 
          className="text-blue-500 hover:underline inline-flex items-center gap-1 break-all"
        >
          "{value}"
          <ExternalLink className="h-3 w-3 inline" />
        </a>
      );
    }
    // Image detection (basic)
    if (value.match(/\.(jpeg|jpg|gif|png|webp)$/i)) {
      // Could show a preview on hover or inline, but keeping it simple for now
      return <span className="text-emerald-600 dark:text-emerald-400">"{value}"</span>;
    }
    return <span className="text-emerald-600 dark:text-emerald-400 break-all">"{value}"</span>;
  }
  if (type === 'number') return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  if (type === 'boolean') return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
  
  return <span>{String(value)}</span>;
};

const KeyRenderer = ({ name }: { name: string }) => (
  <span className="text-purple-700 dark:text-purple-400 mr-1 font-medium">"{name}":</span>
);

export const SmartJsonViewer: React.FC<SmartJsonViewerProps> = ({ 
  data, 
  name, 
  className, 
  initialExpandedDepth = 1,
  depth = 0 
}) => {
  const [isExpanded, setIsExpanded] = useState(depth < initialExpandedDepth);
  const [isHovered, setIsHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const type = getType(data);
  const isObject = type === 'object' || type === 'array';
  const isEmpty = isObject && Object.keys(data).length === 0;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (!isObject) {
    return (
      <div className={cn("font-mono text-xs flex items-start py-0.5", className)}>
        {name && <KeyRenderer name={name} />}
        <ValueRenderer value={data} />
      </div>
    );
  }

  const keys = Object.keys(data);
  const itemCount = keys.length;
  const brackets = type === 'array' ? ['[', ']'] : ['{', '}'];

  return (
    <div 
      className={cn("font-mono text-xs select-text", className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div 
        className={cn(
          "flex items-start gap-1 cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded px-1 -ml-1 py-0.5 transition-colors group",
          !isExpanded && "items-center"
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (!isEmpty) setIsExpanded(!isExpanded);
        }}
      >
        <div className="w-4 h-4 flex items-center justify-center shrink-0 opacity-50 group-hover:opacity-100">
          {!isEmpty && (
            isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
          )}
        </div>
        
        <div className="flex-1 flex items-center flex-wrap gap-1">
          {name && <KeyRenderer name={name} />}
          
          <span className="text-muted-foreground font-bold">{brackets[0]}</span>
          
          {!isExpanded && !isEmpty && (
            <span className="text-muted-foreground flex items-center gap-1 mx-1">
               <MoreHorizontal className="h-3 w-3" />
               <span className="text-[10px] bg-muted px-1 rounded-sm">{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
            </span>
          )}

          {isEmpty && <span className="text-muted-foreground"></span>}

          {(!isExpanded || isEmpty) && (
            <span className="text-muted-foreground font-bold">{brackets[1]}</span>
          )}
        </div>

        {isHovered && (
           <Button
             variant="ghost"
             size="icon"
             className="h-4 w-4 ml-2 opacity-0 group-hover:opacity-100 transition-opacity"
             onClick={handleCopy}
           >
             {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
           </Button>
        )}
      </div>

      {isExpanded && !isEmpty && (
        <div className="flex flex-col">
          <div className="pl-4 ml-2 border-l border-zinc-200 dark:border-zinc-800">
            {keys.map((key) => (
              <SmartJsonViewer
                key={key}
                name={type === 'array' ? undefined : key}
                data={data[key]}
                depth={depth + 1}
                initialExpandedDepth={initialExpandedDepth}
              />
            ))}
          </div>
          <div className="pl-6 py-0.5 text-muted-foreground font-bold">
            {brackets[1]}
          </div>
        </div>
      )}
    </div>
  );
};
