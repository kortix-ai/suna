'use client';

import { useTranslations } from 'next-intl';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  Play,
  Square,
  RefreshCw,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
  Activity,
  TrendingUp,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Timer,
  Info,
} from 'lucide-react';
import { useStressTest, StressTestResult } from '@/hooks/admin/use-stress-test';
import { cn } from '@/lib/utils';
import { LegacyBanner } from '@/components/admin/legacy-banner';

export default function AdminStressTestPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [numRequestsInput, setNumRequestsInput] = useState('5');
  const numRequests = Math.min(200, Math.max(1, parseInt(numRequestsInput) || 5));
  
  const { state, runStressTest, cancelTest, resetTest } = useStressTest();
  
  const stats = useMemo(() => {
    const done = state.results.filter(r => r.status === 'done').length;
    const error = state.results.filter(r => r.status === 'error').length;
    const running = state.results.filter(r => r.status === 'running').length;
    const pending = state.results.filter(r => r.status === 'pending').length;
    const completed = done + error;
    const total = state.results.length || numRequests;
    const progress = total > 0 ? (completed / total) * 100 : 0;
    
    return { done, error, running, pending, completed, total, progress };
  }, [state.results, numRequests]);

  const handleStart = () => {
    runStressTest({
      num_requests: numRequests,
      measure_ttft: true,
    });
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'done':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'error':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'running':
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'done':
        return <Badge variant="default" className="bg-green-500/10 text-green-500 border-green-500/20">Done</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      case 'running':
        return <Badge variant="default" className="bg-blue-500/10 text-blue-500 border-blue-500/20">Running</Badge>;
      default:
        return <Badge variant="secondary">Pending</Badge>;
    }
  };

  // Get visible results (prioritize running and recent completed)
  const visibleResults = useMemo(() => {
    const running = state.results.filter(r => r.status === 'running');
    const completed = state.results
      .filter(r => r.status === 'done' || r.status === 'error')
      .sort((a, b) => (b.total_ttft || b.request_time || 0) - (a.total_ttft || a.request_time || 0));
    
    const combined = [...running, ...completed.slice(0, Math.max(0, 20 - running.length))];
    return combined.sort((a, b) => a.request_id - b.request_id).slice(0, 20);
  }, [state.results]);

  // Build thread URL
  const getThreadUrl = (result: StressTestResult) => {
    if (!result.thread_id) return null;
    return `/legacy/${result.thread_id}`;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-8">
        <LegacyBanner feature={tHardcodedUi.raw('componentsPagesAdminStressTestPage.line104JsxAttrFeatureStressTest')} />
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <Zap className="h-6 w-6 text-yellow-500" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line110JsxTextStressTestAdmin')}</h1>
            <p className="text-base text-muted-foreground mt-2">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line113JsxTextRunLoadTestsWithDetailedTimingBreakdownBypasses')}</p>
          </div>
        </div>

        {/* Timing Explanation with Visual Diagram */}
        <Card className="border-border/50">
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Info className="h-5 w-5 text-blue-500" />
                <p className="font-semibold text-blue-600 dark:text-blue-400">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line124JsxTextTimingMetricsTimeline')}</p>
              </div>
              
              {/* Visual Timeline Diagram */}
              <div className="relative bg-muted/50 rounded-2xl p-4 overflow-x-auto">
                <div className="min-w-[600px]">
                  {/* Timeline header */}
                  <div className="flex items-center gap-2 mb-4 text-xs text-muted-foreground">
                    <span className="font-mono">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line132JsxTextUserClicksQuotSendQuot')}</span>
                    <div className="flex-1 border-t border-dashed border-border" />
                    <span className="font-mono">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line134JsxTextFirstTokenVisible')}</span>
                  </div>
                  
                  {/* Total TTFT bar */}
                  <div className="mb-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-purple-600 dark:text-purple-400 w-32">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line140JsxTextTotalTtft')}</span>
                      <div className="flex-1 h-8 bg-purple-100 dark:bg-purple-500/20 border border-purple-300 dark:border-purple-500/40 rounded flex items-center justify-center">
                        <span className="text-xs text-purple-700 dark:text-purple-300">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line142JsxTextRequestTimeFirstResponse')}</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Request Time + First Response breakdown */}
                  <div className="flex gap-1 mb-3">
                    <div className="w-32" />
                    {/* Request Time */}
                    <div className="flex-1 h-8 bg-blue-100 dark:bg-blue-500/20 border border-blue-300 dark:border-blue-500/40 rounded flex items-center justify-center">
                      <span className="text-xs text-blue-700 dark:text-blue-300">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line152JsxTextRequestTime')}</span>
                    </div>
                    {/* First Response */}
                    <div className="flex-1 h-8 bg-orange-100 dark:bg-orange-500/20 border border-orange-300 dark:border-orange-500/40 rounded flex items-center justify-center">
                      <span className="text-xs text-orange-700 dark:text-orange-300">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line156JsxTextFirstResponse')}</span>
                    </div>
                  </div>
                  
                  {/* Detailed breakdown */}
                  <div className="flex gap-1 mb-4">
                    <div className="w-32" />
                    {/* Request Time details */}
                    <div className="flex-1 flex gap-0.5">
                      <div className="flex-1 h-6 bg-blue-200 dark:bg-blue-900/40 rounded-sm flex items-center justify-center border border-blue-300 dark:border-blue-800/50">
                        <span className="text-xs text-blue-700 dark:text-blue-300 truncate px-1">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line166JsxTextHttpCall')}</span>
                      </div>
                      <div className="flex-1 h-6 bg-blue-200 dark:bg-blue-900/40 rounded-sm flex items-center justify-center border border-blue-300 dark:border-blue-800/50">
                        <span className="text-xs text-blue-700 dark:text-blue-300 truncate px-1">Setup</span>
                      </div>
                      <div className="flex-1 h-6 bg-blue-200 dark:bg-blue-900/40 rounded-sm flex items-center justify-center border border-blue-300 dark:border-blue-800/50">
                        <span className="text-xs text-blue-700 dark:text-blue-300 truncate px-1">Thread</span>
                      </div>
                      <div className="flex-1 h-6 bg-blue-200 dark:bg-blue-900/40 rounded-sm flex items-center justify-center border border-blue-300 dark:border-blue-800/50">
                        <span className="text-xs text-blue-700 dark:text-blue-300 truncate px-1">Agent</span>
                      </div>
                    </div>
                    {/* First Response details */}
                    <div className="flex-1 flex gap-0.5">
                      <div className="flex-[2] h-6 bg-orange-200 dark:bg-orange-900/40 rounded-sm flex items-center justify-center border border-orange-300 dark:border-orange-800/50">
                        <span className="text-xs text-orange-700 dark:text-orange-300 truncate px-1">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line181JsxTextAgentSetup')}</span>
                      </div>
                      <div className="flex-[3] h-6 bg-green-200 dark:bg-green-500/20 rounded-sm flex items-center justify-center border border-green-400 dark:border-green-500/40">
                        <span className="text-xs text-green-700 dark:text-green-300 font-medium truncate px-1">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line184JsxTextLlmTtft')}</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Legend */}
                  <div className="flex flex-wrap gap-4 pt-3 border-t border-border text-xs">
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-sm bg-blue-400 dark:bg-blue-500/40 border border-blue-500 dark:border-blue-500/60" />
                      <span className="text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line193JsxTextRequestTime')}</span>
                      <span className="text-blue-600 dark:text-blue-400 font-mono">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line194JsxTextHttpSetup')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-sm bg-orange-400 dark:bg-orange-500/40 border border-orange-500 dark:border-orange-500/60" />
                      <span className="text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line198JsxTextFirstResponse')}</span>
                      <span className="text-orange-600 dark:text-orange-400 font-mono">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line199JsxTextAgentOverhead')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-sm bg-green-400 dark:bg-green-500/40 border border-green-500 dark:border-green-500/60" />
                      <span className="text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line203JsxTextLlmTtft')}</span>
                      <span className="text-green-600 dark:text-green-400 font-mono">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line204JsxTextPureModelLatency')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-sm bg-purple-400 dark:bg-purple-500/40 border border-purple-500 dark:border-purple-500/60" />
                      <span className="text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line208JsxTextTotalTtft')}</span>
                      <span className="text-purple-600 dark:text-purple-400 font-mono">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line209JsxTextUserWaitTime')}</span>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Formulas */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="bg-muted/50 rounded-2xl p-3 border border-border">
                  <p className="text-muted-foreground mb-1">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line218JsxTextKeyFormula')}</p>
                  <p className="font-mono text-purple-600 dark:text-purple-400">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line219JsxTextTotalTtftRequestTimeFirstResponse')}</p>
                </div>
                <div className="bg-muted/50 rounded-2xl p-3 border border-border">
                  <p className="text-muted-foreground mb-1">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line222JsxTextAgentOverhead')}</p>
                  <p className="font-mono text-orange-600 dark:text-orange-400">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line223JsxTextAgentOverheadFirstResponseLlmTtft')}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line233JsxTextTestConfiguration')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-6">
              <div className="space-y-2">
                <Label htmlFor="numRequests">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line238JsxTextNumberOfRequests')}</Label>
                <Input
                  id="numRequests"
                  type="number"
                  min={1}
                  max={200}
                  value={numRequestsInput}
                  onChange={(e) => setNumRequestsInput(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onBlur={() => {
                    // Normalize to valid value on blur
                    const val = Math.min(200, Math.max(1, parseInt(numRequestsInput) || 5));
                    setNumRequestsInput(String(val));
                  }}
                  disabled={state.isRunning}
                  className="w-32"
                />
              </div>
              
              <div className="flex gap-2">
                {!state.isRunning ? (
                  <Button onClick={handleStart} className="gap-2">
                    <Play className="h-4 w-4" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line261JsxTextStartTest')}</Button>
                ) : (
                  <Button onClick={cancelTest} variant="destructive" className="gap-2">
                    <Square className="h-4 w-4" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line266JsxTextStopTest')}</Button>
                )}
                
                {(state.summary || state.error) && !state.isRunning && (
                  <Button onClick={resetTest} variant="outline" className="gap-2">
                    <RefreshCw className="h-4 w-4" />
                    Reset
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Progress and Stats */}
        {(state.isRunning || state.results.length > 0) && (
          <>
            {/* Progress Bar */}
            <Card>
              <CardContent className="pt-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {state.isRunning ? (
                        <>Batch {state.currentBatch}/{state.totalBatches}{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line291JsxTextWaitingForLlmResponse')}</>
                      ) : (
                        'Completed'
                      )}
                    </span>
                    <span className="font-medium">{stats.completed}/{stats.total} requests</span>
                  </div>
                  <Progress value={stats.progress} className="h-2" />
                  
                  {/* Quick Stats */}
                  <div className="grid grid-cols-4 gap-4 pt-2">
                    <div className="flex items-center gap-2">
                      <Loader2 className={cn("h-4 w-4 text-blue-500", state.isRunning && "animate-spin")} />
                      <span className="text-sm">Running: {stats.running}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <span className="text-sm">Done: {stats.done}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <XCircle className="h-4 w-4 text-red-500" />
                      <span className="text-sm">Failed: {stats.error}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">Pending: {stats.pending}</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Results Table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Activity className="h-5 w-5" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line328JsxTextLiveResults')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="rounded-2xl border overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="h-10 px-4 text-left text-sm font-medium">#</th>
                        <th className="h-10 px-4 text-left text-sm font-medium">Status</th>
                        <th className="h-10 px-4 text-left text-sm font-medium">Thread</th>
                        <th className="h-10 px-4 text-right text-sm font-medium">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line339JsxTextRequestTime')}</th>
                        <th className="h-10 px-4 text-right text-sm font-medium">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line340JsxTextFirstResponse')}</th>
                        <th className="h-10 px-4 text-right text-sm font-medium">
                          <span className="text-green-600">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line342JsxTextLlmTtft')}</span>
                        </th>
                        <th className="h-10 px-4 text-right text-sm font-medium">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line344JsxTextTotalTtft')}</th>
                        <th className="h-10 px-4 text-left text-sm font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleResults.map((result) => {
                        const threadUrl = getThreadUrl(result);
                        return (
                          <tr key={result.request_id} className="border-b">
                            <td className="h-12 px-4 text-sm font-mono">{result.request_id}</td>
                            <td className="h-12 px-4">
                              <div className="flex items-center gap-2">
                                {getStatusIcon(result.status)}
                                {getStatusBadge(result.status)}
                              </div>
                            </td>
                            <td className="h-12 px-4 text-sm">
                              {threadUrl ? (
                                <Link 
                                  href={threadUrl}
                                  target="_blank"
                                  className="flex items-center gap-1 text-blue-500 hover:text-blue-600 hover:underline font-mono"
                                >
                                  {result.thread_id?.substring(0, 8)}...
                                  <ExternalLink className="h-3 w-3" />
                                </Link>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </td>
                            <td className="h-12 px-4 text-sm text-right font-mono">
                              {result.request_time > 0 ? `${result.request_time.toFixed(2)}s` : '-'}
                            </td>
                            <td className="h-12 px-4 text-sm text-right font-mono">
                              {result.time_to_first_response != null ? (
                                <span className="text-orange-500">{result.time_to_first_response.toFixed(2)}s</span>
                              ) : result.status === 'running' ? (
                                <Loader2 className="h-4 w-4 animate-spin inline" />
                              ) : (
                                '-'
                              )}
                            </td>
                            <td className="h-12 px-4 text-sm text-right font-mono">
                              {result.llm_ttft != null ? (
                                <span className="text-green-500 font-semibold">{result.llm_ttft.toFixed(2)}s</span>
                              ) : result.status === 'running' ? (
                                <Loader2 className="h-4 w-4 animate-spin inline" />
                              ) : (
                                '-'
                              )}
                            </td>
                            <td className="h-12 px-4 text-sm text-right font-mono">
                              {result.total_ttft != null ? (
                                <span className="text-purple-500 font-semibold">{result.total_ttft.toFixed(2)}s</span>
                              ) : result.status === 'running' ? (
                                <Loader2 className="h-4 w-4 animate-spin inline" />
                              ) : (
                                '-'
                              )}
                            </td>
                            <td className="h-12 px-4 text-sm text-red-500 max-w-[300px]">
                              {result.error ? (
                                <TooltipProvider>
                                  <Tooltip delayDuration={0}>
                                    <TooltipTrigger asChild>
                                      <span className="block truncate cursor-help">
                                        {result.error}
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="left" className="max-w-md break-all text-xs">
                                      {result.error}
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              ) : (
                                '-'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {visibleResults.length === 0 && (
                        <tr>
                          <td colSpan={8} className="h-24 text-center text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line428JsxTextNoResultsYet')}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {stats.total > 20 && (
                  <p className="text-sm text-muted-foreground mt-2 text-center">
                    Showing {Math.min(20, visibleResults.length)} of {stats.total} requests
                  </p>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* Summary */}
        {state.summary && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line451JsxTextTestSummary')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line457JsxTextTotalRequests')}</p>
                  <p className="text-2xl font-bold">{state.summary.total_requests}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Successful</p>
                  <p className="text-2xl font-bold text-green-500">
                    {state.summary.successful} 
                    <span className="text-sm font-normal text-muted-foreground ml-1">
                      ({((state.summary.successful / state.summary.total_requests) * 100).toFixed(1)}%)
                    </span>
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Failed</p>
                  <p className="text-2xl font-bold text-red-500">
                    {state.summary.failed}
                    <span className="text-sm font-normal text-muted-foreground ml-1">
                      ({((state.summary.failed / state.summary.total_requests) * 100).toFixed(1)}%)
                    </span>
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line479JsxTextTotalTestTime')}</p>
                  <p className="text-2xl font-bold">{state.summary.total_time}s</p>
                </div>
              </div>

              {/* Request Times */}
              <div className="border-t mt-6 pt-6">
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <Clock className="h-4 w-4" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line488JsxTextRequestTimes')}</h4>
                <p className="text-xs text-muted-foreground mb-4">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line491JsxTextTimeForHttpRequestToCompleteDistributedAcross')}</p>
                <div className="grid grid-cols-3 gap-6">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Min</p>
                    <p className="text-xl font-semibold">{state.summary.min_request_time}s</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Average</p>
                    <p className="text-xl font-semibold">{state.summary.avg_request_time}s</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">Max</p>
                    <p className="text-xl font-semibold">{state.summary.max_request_time}s</p>
                  </div>
                </div>
              </div>

              {/* Time to First Response */}
              {state.summary.first_response_measured > 0 && (
                <div className="border-t mt-6 pt-6">
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Timer className="h-4 w-4 text-orange-500" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line514JsxTextTimeToFirstResponse')}<Badge variant="secondary" className="ml-2">{state.summary.first_response_measured} measured</Badge>
                  </h4>
                  <p className="text-xs text-muted-foreground mb-4">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line518JsxTextTimeFromAgentStartUntilFirstLlmResponse')}</p>
                  <div className="grid grid-cols-3 gap-6">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Min</p>
                      <p className="text-xl font-semibold text-orange-500">
                        {state.summary.min_time_to_first_response != null ? `${state.summary.min_time_to_first_response}s` : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Average</p>
                      <p className="text-xl font-semibold text-orange-500">
                        {state.summary.avg_time_to_first_response != null ? `${state.summary.avg_time_to_first_response}s` : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Max</p>
                      <p className="text-xl font-semibold text-orange-500">
                        {state.summary.max_time_to_first_response != null ? `${state.summary.max_time_to_first_response}s` : '-'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* LLM TTFT (Pure LiteLLM call time) */}
              {state.summary.llm_ttft_measured > 0 && (
                <div className="border-t mt-6 pt-6">
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-green-500" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line548JsxTextLlmTtftPureModelLatency')}<Badge variant="secondary" className="ml-2 bg-green-500/10 text-green-600">{state.summary.llm_ttft_measured} measured</Badge>
                  </h4>
                  <p className="text-xs text-muted-foreground mb-4">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line552JsxTextActualTimeForTheLlmApiCallTo')}</p>
                  <div className="grid grid-cols-3 gap-6">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Min</p>
                      <p className="text-xl font-semibold text-green-500">
                        {state.summary.min_llm_ttft != null ? `${state.summary.min_llm_ttft}s` : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Average</p>
                      <p className="text-xl font-semibold text-green-500">
                        {state.summary.avg_llm_ttft != null ? `${state.summary.avg_llm_ttft}s` : '-'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Max</p>
                      <p className="text-xl font-semibold text-green-500">
                        {state.summary.max_llm_ttft != null ? `${state.summary.max_llm_ttft}s` : '-'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Total TTFT */}
              {state.summary.min_total_ttft != null && (
                <div className="border-t mt-6 pt-6">
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-purple-500" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line582JsxTextTotalTtftEndToEnd')}</h4>
                  <p className="text-xs text-muted-foreground mb-4">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line585JsxTextCompleteTimeFromUserRequestUntilFirstResponse')}</p>
                  <div className="grid grid-cols-3 gap-6">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Min</p>
                      <p className="text-xl font-semibold text-purple-500">
                        {state.summary.min_total_ttft}s
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Average</p>
                      <p className="text-xl font-semibold text-purple-500">
                        {state.summary.avg_total_ttft}s
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">Max</p>
                      <p className="text-xl font-semibold text-purple-500">
                        {state.summary.max_total_ttft}s
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="border-t mt-6 pt-6">
                <h4 className="text-sm font-medium mb-4">Throughput</h4>
                <p className="text-xl font-semibold">{state.summary.throughput} req/s</p>
              </div>

              {Object.keys(state.summary.error_breakdown).length > 0 && (
                <div className="border-t mt-6 pt-6">
                  <h4 className="text-sm font-medium mb-4 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-500" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line619JsxTextErrorBreakdown')}</h4>
                  <div className="space-y-2">
                    {Object.entries(state.summary.error_breakdown).map(([error, count]) => (
                      <div key={error} className="flex items-start gap-2 text-sm">
                        <Badge variant="destructive" className="shrink-0">{count}x</Badge>
                        <span className="text-muted-foreground break-all">{error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Timing Breakdown Table */}
              {state.summary.timing_breakdown && Object.keys(state.summary.timing_breakdown).length > 0 && (
                <div className="border-t mt-6 pt-6">
                  <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <Timer className="h-4 w-4 text-blue-500" />{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line637JsxTextRequestTimingBreakdown')}</h4>
                  <p className="text-xs text-muted-foreground mb-4">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line640JsxTextDetailedBreakdownOfTimeSpentInEachPhase')}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-2 font-medium">Phase</th>
                          <th className="text-right py-2 px-2 font-medium">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line647JsxTextMinMs')}</th>
                          <th className="text-right py-2 px-2 font-medium">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line648JsxTextAvgMs')}</th>
                          <th className="text-right py-2 px-2 font-medium">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line649JsxTextMaxMs')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.summary.timing_breakdown.load_config_ms && (
                          <tr className="border-b border-border/50">
                            <td className="py-2 px-2">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line655JsxTextLoadConfig')}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.load_config_ms.min}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.load_config_ms.avg}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.load_config_ms.max}</td>
                          </tr>
                        )}
                        {state.summary.timing_breakdown.get_model_ms && (
                          <tr className="border-b border-border/50">
                            <td className="py-2 px-2">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line663JsxTextGetModel')}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.get_model_ms.min}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.get_model_ms.avg}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.get_model_ms.max}</td>
                          </tr>
                        )}
                        {state.summary.timing_breakdown.create_project_ms && (
                          <tr className="border-b border-border/50">
                            <td className="py-2 px-2">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line671JsxTextCreateProject')}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_project_ms.min}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_project_ms.avg}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_project_ms.max}</td>
                          </tr>
                        )}
                        {state.summary.timing_breakdown.create_thread_ms && (
                          <tr className="border-b border-border/50">
                            <td className="py-2 px-2">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line679JsxTextCreateThread')}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_thread_ms.min}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_thread_ms.avg}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_thread_ms.max}</td>
                          </tr>
                        )}
                        {state.summary.timing_breakdown.create_message_and_run_ms && (
                          <tr className="border-b border-border/50">
                            <td className="py-2 px-2">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line687JsxTextCreateMessageRun')}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_message_and_run_ms.min}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_message_and_run_ms.avg}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.create_message_and_run_ms.max}</td>
                          </tr>
                        )}
                        {state.summary.timing_breakdown.total_setup_ms && (
                          <tr className="bg-muted/30 font-medium">
                            <td className="py-2 px-2">{tHardcodedUi.raw('componentsPagesAdminStressTestPage.line695JsxTextTotalSetup')}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.total_setup_ms.min}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.total_setup_ms.avg}</td>
                            <td className="text-right py-2 px-2 font-mono">{state.summary.timing_breakdown.total_setup_ms.max}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Error Display */}
        {state.error && (
          <Card className="border-red-500/50 bg-red-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-red-500">
                <XCircle className="h-5 w-5" />
                <span className="font-medium">Error: {state.error}</span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
