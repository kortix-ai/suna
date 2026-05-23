import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, ExternalLink, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

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

/** Truncate long strings for collapsed preview */
function truncateString(val: string, maxLen: number = 80): string {
  if (val.length <= maxLen) return val;
  return val.slice(0, maxLen) + '...';
}

const ValueRenderer = ({ value }: { value: any }) => {
  const type = getType(value);

  if (type === 'null') return <span className="text-muted-foreground/50 italic">null</span>;
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
          &quot;{truncateString(value)}&quot;
          <ExternalLink className="h-3 w-3 inline flex-shrink-0" />
        </a>
      );
    }
    // File path detection
    if (value.startsWith('/') && !value.includes('\n') && value.length < 300) {
      return <span className="text-foreground/70 break-all">&quot;{value}&quot;</span>;
    }
    // Long string truncation in collapsed view
    return <span className="text-foreground/60 break-all">&quot;{value}&quot;</span>;
  }
  if (type === 'number') return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  if (type === 'boolean') return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
  
  return <span>{String(value)}</span>;
};

const KeyRenderer = ({ name }: { name: string }) => (
  <span className="text-muted-foreground/80 mr-1">
    <span className="font-medium">{name}</span>
    <span className="text-muted-foreground/40">:</span>
  </span>
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
          "flex items-start gap-1 cursor-pointer hover:bg-muted/50 rounded px-1 -ml-1 py-0.5 transition-colors group",
          !isExpanded && "items-center"
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (!isEmpty) setIsExpanded(!isExpanded);
        }}
      >
        <div className="w-4 h-4 flex items-center justify-center shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
          {!isEmpty && (
            isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
          )}
        </div>
        
        <div className="flex-1 flex items-center flex-wrap gap-1">
          {name && <KeyRenderer name={name} />}
          
          <span className="text-muted-foreground/50">{brackets[0]}</span>
          
          {!isExpanded && !isEmpty && (
            <span className="text-muted-foreground/50 flex items-center gap-1.5 mx-0.5">
               <MoreHorizontal className="h-3 w-3" />
               <span className="text-xs bg-muted/60 px-1.5 py-0.5 rounded">{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
            </span>
          )}

          {isEmpty && <span className="text-muted-foreground/40"></span>}

          {(!isExpanded || isEmpty) && (
            <span className="text-muted-foreground/50">{brackets[1]}</span>
          )}
        </div>

        {isHovered && (
           <Button
             variant="ghost"
             size="icon"
             className="h-4 w-4 ml-2 opacity-0 group-hover:opacity-100 transition-opacity"
             onClick={handleCopy}
           >
             {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
           </Button>
        )}
      </div>

      {isExpanded && !isEmpty && (
        <div className="flex flex-col">
          <div className="pl-4 ml-2 border-l border-border/50">
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
          <div className="pl-6 py-0.5 text-muted-foreground/50">
            {brackets[1]}
          </div>
        </div>
      )}
    </div>
  );
};
