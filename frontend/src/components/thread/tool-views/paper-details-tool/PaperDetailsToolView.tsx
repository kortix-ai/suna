import React, { useState } from 'react';
import {
  BookOpen,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Users,
  Quote,
  Award,
  Calendar,
  FileText,
  Copy,
  TrendingUp,
  BookOpenCheck,
  Link2,
  ChevronDown,
  ChevronUp,
  Star,
  GitBranch
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { LoadingState } from '../shared/LoadingState';
import { extractPaperDetailsData, Author, CitationReference, PaperDetails } from './_utils';

export function PaperDetailsToolView({
  name = 'get-paper-details',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [showAllCitations, setShowAllCitations] = useState(false);
  const [showAllReferences, setShowAllReferences] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const {
    paper,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractPaperDetailsData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const renderAuthor = (author: Author, index: number) => (
    <TooltipProvider key={index}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" className="cursor-pointer">
            {author.name}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-1">
            <p className="font-medium">{author.name}</p>
            {author.affiliations && author.affiliations.length > 0 && (
              <p className="text-xs text-muted-foreground">{author.affiliations.join(', ')}</p>
            )}
            {author.h_index !== undefined && author.h_index > 0 && (
              <div className="flex items-center gap-3 text-xs pt-1">
                <span>Papers: {author.paper_count || 0}</span>
                <span>Citations: {author.citation_count || 0}</span>
                <span>h-index: {author.h_index}</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  const renderCitationReference = (item: CitationReference, index: number) => (
    <Card key={index} className="p-3 hover:bg-muted/50 transition-colors">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium leading-relaxed line-clamp-2">
              {item.title}
            </h4>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 flex-shrink-0"
            asChild
          >
            <a
              href={`https://www.semanticscholar.org/paper/${item.paper_id}`}
              target="_blank"
              rel="noopener noreferrer"
              title="View on Semantic Scholar"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </Button>
        </div>
        
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {item.year && (
            <Badge variant="outline" className="text-xs">
              {item.year}
            </Badge>
          )}
          {item.citation_count > 0 && (
            <div className="flex items-center gap-1">
              <Quote className="h-3 w-3" />
              <span>{item.citation_count}</span>
            </div>
          )}
        </div>
        
        {item.authors && item.authors.length > 0 && (
          <p className="text-xs text-muted-foreground line-clamp-1">
            {item.authors.slice(0, 3).join(', ')}
            {item.authors.length > 3 && ` +${item.authors.length - 3} more`}
          </p>
        )}
      </div>
    </Card>
  );

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-emerald-500/20 border border-emerald-500/20">
              <BookOpenCheck className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className={
                  actualIsSuccess
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                    : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                }
              >
                {actualIsSuccess ? (
                  <CheckCircle className="h-3.5 w-3.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
                {actualIsSuccess ? 'Details loaded' : 'Failed to load'}
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && !paper ? (
          <LoadingState
            icon={BookOpenCheck}
            iconColor="text-emerald-500"
            bgColor="bg-emerald-500/10"
            title="Loading paper details"
            showProgress={true}
          />
        ) : paper ? (
          <ScrollArea className="h-full w-full">
            <TooltipProvider>
              <div className="p-4 space-y-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h2 className="text-xl font-semibold leading-relaxed">
                      {paper.title}
                    </h2>
                    
                    <div className="flex flex-wrap items-center gap-2">
                      {paper.year && (
                        <Badge variant="outline" className="gap-1">
                          <Calendar className="h-3 w-3" />
                          {paper.year}
                        </Badge>
                      )}
                      {paper.venue && (
                        <Badge variant="outline" className="gap-1">
                          <Award className="h-3 w-3" />
                          {paper.venue}
                        </Badge>
                      )}
                      {paper.is_open_access && (
                        <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                          Open Access
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-1 cursor-pointer">
                          <Quote className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{paper.citation_count}</span>
                          <span className="text-muted-foreground">citations</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="space-y-1">
                          <p>Total citations: {paper.citation_count}</p>
                          <p>Influential: {paper.influential_citation_count}</p>
                        </div>
                      </TooltipContent>
                    </Tooltip>

                    <div className="flex items-center gap-1">
                      <GitBranch className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{paper.reference_count}</span>
                      <span className="text-muted-foreground">references</span>
                    </div>

                    {paper.influential_citation_count > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-1 cursor-pointer">
                            <Star className="h-4 w-4 text-yellow-500" />
                            <span className="font-medium">{paper.influential_citation_count}</span>
                            <span className="text-muted-foreground">influential</span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          Highly influential citations
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      className="gap-2"
                      asChild
                    >
                      <a href={paper.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        View on Semantic Scholar
                      </a>
                    </Button>
                    
                    {paper.pdf_info?.url && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        asChild
                      >
                        <a href={paper.pdf_info.url} target="_blank" rel="noopener noreferrer">
                          <FileText className="h-4 w-4" />
                          Open PDF
                        </a>
                      </Button>
                    )}
                  </div>
                </div>

                <Separator />

                {paper.authors && paper.authors.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-sm font-medium">Authors</h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {paper.authors.map(renderAuthor)}
                    </div>
                  </div>
                )}

                {paper.tldr && (
                  <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                      <h3 className="text-sm font-medium text-blue-900 dark:text-blue-100">TL;DR</h3>
                    </div>
                    <p className="text-sm text-blue-900/80 dark:text-blue-100/80 leading-relaxed">
                      {paper.tldr}
                    </p>
                  </div>
                )}

                {paper.abstract && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Abstract</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {paper.abstract}
                    </p>
                  </div>
                )}

                {paper.fields_of_study && paper.fields_of_study.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Fields of Study</h3>
                    <div className="flex flex-wrap gap-2">
                      {paper.fields_of_study.map((field, idx) => (
                        <Badge key={idx} variant="outline">{field}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {paper.citation_styles?.bibtex && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium">BibTeX Citation</h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(paper.citation_styles!.bibtex!, 'bibtex')}
                      >
                        {copiedField === 'bibtex' ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <pre className="text-xs bg-muted p-3 rounded-lg overflow-x-auto">
                      <code>{paper.citation_styles.bibtex}</code>
                    </pre>
                  </div>
                )}

                {paper.external_ids && Object.keys(paper.external_ids).length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Link2 className="h-4 w-4 text-muted-foreground" />
                      <h3 className="text-sm font-medium">External IDs</h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(paper.external_ids).map(([key, value]) => (
                        <Badge key={key} variant="outline" className="font-mono text-xs">
                          {key}: {String(value)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {paper.citations && paper.citations.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Quote className="h-4 w-4 text-muted-foreground" />
                        <h3 className="text-sm font-medium">
                          Citations ({paper.citations.length})
                        </h3>
                      </div>
                      {paper.citations.length > 5 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowAllCitations(!showAllCitations)}
                          className="gap-1"
                        >
                          {showAllCitations ? (
                            <>
                              <ChevronUp className="h-4 w-4" />
                              Show less
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-4 w-4" />
                              Show all
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                    <div className="space-y-2">
                      {(showAllCitations ? paper.citations : paper.citations.slice(0, 5)).map(renderCitationReference)}
                    </div>
                  </div>
                )}

                {paper.references && paper.references.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <GitBranch className="h-4 w-4 text-muted-foreground" />
                        <h3 className="text-sm font-medium">
                          References ({paper.references.length})
                        </h3>
                      </div>
                      {paper.references.length > 5 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowAllReferences(!showAllReferences)}
                          className="gap-1"
                        >
                          {showAllReferences ? (
                            <>
                              <ChevronUp className="h-4 w-4" />
                              Show less
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-4 w-4" />
                              Show all
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                    <div className="space-y-2">
                      {(showAllReferences ? paper.references : paper.references.slice(0, 5)).map(renderCitationReference)}
                    </div>
                  </div>
                )}
              </div>
            </TooltipProvider>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-muted/20">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center mb-4">
              <BookOpenCheck className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              No Paper Details Found
            </h3>
            <p className="text-sm text-muted-foreground text-center">
              Unable to load paper details. Please try again.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 bg-muted/30 backdrop-blur-sm border-t flex justify-between items-center gap-4">
        <div className="flex items-center gap-2">
          {!isStreaming && paper && (
            <>
              <Badge variant="outline" className="text-xs">
                <BookOpenCheck className="h-3 w-3 mr-1" />
                Paper ID: {paper.paper_id.slice(0, 8)}...
              </Badge>
              {paper.corpus_id && (
                <Badge variant="outline" className="text-xs">
                  Corpus: {paper.corpus_id}
                </Badge>
              )}
            </>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          {actualToolTimestamp && !isStreaming
            ? formatTimestamp(actualToolTimestamp)
            : actualAssistantTimestamp
              ? formatTimestamp(actualAssistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}

