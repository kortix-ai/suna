import React from 'react';
import { ContentFormat, FormatDetectionResult } from './mcp-format-detector';
import { MarkdownRenderer } from '@/components/file-renderers/markdown-renderer';
import { CsvRenderer } from '@/components/thread/preview-renderers/csv-renderer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Search, Database, FileText, Link2, Key, AlertTriangle,
  Copy, Globe, FileCode, Table, BookOpen, ExternalLink
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface MCPContentRendererProps {
  detectionResult: FormatDetectionResult;
  rawContent: any;
}

// Generic search result interface
interface SearchResult {
  title: string;
  url?: string;
  link?: string;
  summary?: string;
  description?: string;
  text?: string;
  author?: string;
  date?: string;
  publishedDate?: string;
  image?: string;
  favicon?: string;
  [key: string]: any;
}

// Renderer for search results
function SearchResultsRenderer({ data, metadata }: { data: any; metadata?: any }) {
  // Normalize search results from various formats
  const normalizeResults = (data: any): SearchResult[] => {
    let items: any[] = [];

    if (data?.results) items = data.results;
    else if (data?.data) items = data.data;
    else if (Array.isArray(data)) items = data;
    else return [];

    return items.map((item, index) => ({
      ...item,
      url: item.url || item.link || item.href,
      summary: item.summary || item.description || item.text || item.snippet || item.content,
      date: item.date || item.publishedDate || item.published_date,
      title: item.title || item.name || `Result ${index + 1}`
    })).filter(item => item.title || item.url);
  };

  const results = normalizeResults(data);
  const meta = metadata || data;

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {results.length} search results
          </span>
        </div>
        {meta?.costDollars?.total && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Cost: ${meta.costDollars.total}
          </div>
        )}
      </div>

      {(meta?.autopromptString || meta?.query) && (
        <div className="mb-4 p-2 bg-zinc-50 dark:bg-zinc-900 rounded text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium">Query: </span>
          <span className="italic">{meta.autopromptString || meta.query}</span>
        </div>
      )}

      <ScrollArea className="max-h-96">
        <div className="space-y-3">
          {results.map((result, idx) => (
            <Card key={idx} className="p-3 bg-card border border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors">
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <Badge variant="outline" className="text-xs shrink-0 mt-0.5">
                    {idx + 1}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2 leading-snug">
                      {result.title}
                    </h4>
                  </div>
                  {result.image && (
                    <img
                      src={result.image}
                      alt=""
                      className="w-16 h-12 object-cover rounded border border-zinc-200 dark:border-zinc-700"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )}
                </div>

                {(result.author || result.date) && (
                  <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {result.author && <span>By {result.author}</span>}
                    {result.date && (
                      <span>• {new Date(result.date).toLocaleDateString()}</span>
                    )}
                  </div>
                )}

                {result.url && (
                  <div className="flex items-center gap-1.5 text-xs">
                    {result.favicon && (
                      <img
                        src={result.favicon}
                        alt=""
                        className="w-4 h-4"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}
                    <Globe className="h-3 w-3 text-zinc-500" />
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 dark:text-blue-400 hover:underline truncate flex-1"
                    >
                      {result.url}
                    </a>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => navigator.clipboard?.writeText(result.url!)}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Copy URL</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                )}

                {result.summary && (
                  <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                    {result.summary}
                  </p>
                )}
              </div>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// Renderer for table data
function TableRenderer({ data }: { data: any }) {
  const renderAsTable = (items: any[]) => {
    if (!items.length) return null;

    const headers = Object.keys(items[0]);

    return (
      <div className="p-3">
        <div className="flex items-center gap-2 mb-3">
          <Table className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Table Data ({items.length} rows)
          </span>
        </div>
        <ScrollArea className="max-h-96">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 dark:border-zinc-700">
              <tr>
                {headers.map((header, idx) => (
                  <th key={idx} className="px-3 py-2 text-left font-medium text-zinc-700 dark:text-zinc-300">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-zinc-100 dark:border-zinc-800">
                  {headers.map((header, cellIdx) => (
                    <td key={cellIdx} className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                      {String(row[header] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </div>
    );
  };

  if (Array.isArray(data)) {
    return renderAsTable(data);
  }

  return <JsonRenderer data={data} />;
}

// Renderer for JSON data
function JsonRenderer({ data }: { data: any }) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <Database className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Structured Data
        </span>
      </div>
      <ScrollArea className="max-h-96">
        <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-700 dark:text-zinc-300">
          {JSON.stringify(data, null, 2)}
        </pre>
      </ScrollArea>
    </div>
  );
}

// Renderer for key-value pairs
function KeyValueRenderer({ content }: { content: string }) {
  const lines = content.split('\n').filter(line => line.includes(':'));
  const pairs = lines.map(line => {
    const [key, ...valueParts] = line.split(':');
    return { key: key.trim(), value: valueParts.join(':').trim() };
  });

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <Key className="h-4 w-4 text-green-600 dark:text-green-400" />
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Properties
        </span>
      </div>
      <div className="space-y-2">
        {pairs.map((pair, idx) => (
          <div key={idx} className="flex items-start gap-2 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300 min-w-[120px]">
              {pair.key}:
            </span>
            <span className="text-zinc-600 dark:text-zinc-400 break-all">
              {pair.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Renderer for URL lists
function UrlListRenderer({ content }: { content: string }) {
  const urls = content.match(/https?:\/\/\S+/g) || [];

  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <Link2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          URLs ({urls.length})
        </span>
      </div>
      <div className="space-y-2">
        {urls.map((url, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <ExternalLink className="h-3 w-3 text-zinc-500" />
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate"
            >
              {url}
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

// Renderer for errors
function ErrorRenderer({ content }: { content: string }) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
        <span className="text-sm font-medium text-red-700 dark:text-red-300">
          Error Details
        </span>
      </div>
      <div className="p-3 bg-red-50/50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
        <pre className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap font-mono">
          {content}
        </pre>
      </div>
    </div>
  );
}

// Default text renderer
function TextRenderer({ content }: { content: string }) {
  return (
    <div className="p-3">
      <ScrollArea className="max-h-96">
        <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
          {content}
        </p>
      </ScrollArea>
    </div>
  );
}

// Main renderer component
export function MCPContentRenderer({ detectionResult, rawContent }: MCPContentRendererProps) {
  const { format, confidence, metadata, parsedData } = detectionResult;

  // Convert content to string if needed
  const contentStr = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent, null, 2);

  // Select appropriate renderer based on detected format
  switch (format) {
    case ContentFormat.SEARCH_RESULTS:
      return <SearchResultsRenderer data={parsedData || rawContent} metadata={metadata} />;

    case ContentFormat.TABLE:
      return <TableRenderer data={parsedData || rawContent} />;

    case ContentFormat.JSON:
      return <JsonRenderer data={parsedData || rawContent} />;

    case ContentFormat.MARKDOWN:
      return (
        <div className="p-3">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Markdown Content
            </span>
          </div>
          <MarkdownRenderer content={contentStr} />
        </div>
      );

    case ContentFormat.CSV:
      return <CsvRenderer content={contentStr} />;

    case ContentFormat.KEY_VALUE:
      return <KeyValueRenderer content={contentStr} />;

    case ContentFormat.URL_LIST:
      return <UrlListRenderer content={contentStr} />;

    case ContentFormat.ERROR:
      return <ErrorRenderer content={contentStr} />;

    case ContentFormat.CODE:
      return (
        <div className="p-3">
          <div className="flex items-center gap-2 mb-3">
            <FileCode className="h-4 w-4 text-green-600 dark:text-green-400" />
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Code Output
            </span>
          </div>
          <ScrollArea className="max-h-96">
            <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 p-3 rounded">
              {contentStr}
            </pre>
          </ScrollArea>
        </div>
      );

    default:
      return <TextRenderer content={contentStr} />;
  }
} 