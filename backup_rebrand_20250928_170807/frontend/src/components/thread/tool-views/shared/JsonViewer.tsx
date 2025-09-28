import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface JsonViewerProps {
  data: any;
  title: string;
  defaultExpanded?: boolean;
  className?: string;
}

export const JsonViewer: React.FC<JsonViewerProps> = ({ 
  data, 
  title, 
  defaultExpanded = false, 
  className = "" 
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  const formatJson = (obj: any, indent = 0): React.ReactNode => {
    if (obj === null) return <span className="text-gray-500">null</span>;
    if (obj === undefined) return <span className="text-gray-500">undefined</span>;
    
    if (typeof obj === 'string') {
      return <span className="text-green-600 dark:text-green-400">"{obj}"</span>;
    }
    
    if (typeof obj === 'number') {
      return <span className="text-blue-600 dark:text-blue-400">{obj}</span>;
    }
    
    if (typeof obj === 'boolean') {
      return <span className="text-purple-600 dark:text-purple-400">{obj.toString()}</span>;
    }
    
    if (Array.isArray(obj)) {
      if (obj.length === 0) return <span>[]</span>;
      
      return (
        <div>
          <span>[</span>
          <div className="ml-4">
            {obj.map((item, index) => (
              <div key={index}>
                {formatJson(item, indent + 1)}
                {index < obj.length - 1 && <span>,</span>}
              </div>
            ))}
          </div>
          <span>]</span>
        </div>
      );
    }
    
    if (typeof obj === 'object') {
      const keys = Object.keys(obj);
      if (keys.length === 0) return <span>{'{}'}</span>;
      
      return (
        <div>
          <span>{'{'}</span>
          <div className="ml-4">
            {keys.map((key, index) => (
              <div key={key} className="flex">
                <span className="text-red-600 dark:text-red-400">"{key}"</span>
                <span>: </span>
                <div className="flex-1">
                  {formatJson(obj[key], indent + 1)},
                </div>
              </div>
            ))}
          </div>
          <span>{'}'}</span>
        </div>
      );
    }
    
    return <span>{String(obj)}</span>;
  };

  return (
    <div className={`border border-border rounded-lg ${className}`}>
      <div className="flex items-center justify-between p-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="h-6 w-6 p-0"
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
          <Badge variant="outline" className="text-xs font-mono">
            {title}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-6 w-6 p-0"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      </div>
      
      {isExpanded && (
        <div className="p-3">
          <pre className="text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-background/50 p-3 rounded-lg border max-h-24 md:max-h-48">
            {formatJson(data)}
          </pre>
        </div>
      )}
    </div>
  );
};
