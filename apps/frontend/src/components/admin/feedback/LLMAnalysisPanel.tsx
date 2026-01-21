'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  useAdminFeedbackAnalysis,
  type LLMAnalysisResponse,
  type LLMAnalysisRequest 
} from '@/hooks/admin/use-admin-feedback';
import { 
  Sparkles, 
  AlertTriangle,
  CheckCircle2, 
  Lightbulb,
  Target,
  MessageSquareQuote,
  Loader2,
  Zap,
  ArrowRight
} from 'lucide-react';

export function LLMAnalysisPanel() {
  const [focusArea, setFocusArea] = useState<string>('all');
  const [days, setDays] = useState(30);
  const [analysis, setAnalysis] = useState<LLMAnalysisResponse | null>(null);
  
  const analysisMutation = useAdminFeedbackAnalysis();

  const handleAnalyze = async () => {
    const request: LLMAnalysisRequest = {
      focus_area: focusArea as 'negative' | 'positive' | 'all' | 'critical',
      days,
      max_feedback: 200,
    };
    
    const result = await analysisMutation.mutateAsync(request);
    setAnalysis(result);
  };

  const getSeverityStyles = (severity: string) => {
    if (severity === 'high') return 'border-l-destructive bg-destructive/5';
    return 'border-l-secondary bg-secondary/5';
  };

  const getEffortDots = (effort: string) => {
    const count = effort === 'small' ? 1 : effort === 'medium' ? 2 : 3;
    return (
      <div className="flex gap-0.5">
        {[1, 2, 3].map((i) => (
          <div 
            key={i} 
            className={`w-1.5 h-1.5 rounded-full ${i <= count ? 'bg-secondary' : 'bg-muted'}`} 
          />
        ))}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-secondary" />
            <CardTitle className="text-base font-medium">AI Analysis</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Select value={focusArea} onValueChange={setFocusArea}>
              <SelectTrigger className="w-[120px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Feedback</SelectItem>
                <SelectItem value="negative">Negative Only</SelectItem>
                <SelectItem value="positive">Positive Only</SelectItem>
                <SelectItem value="critical">Critical (≤2★)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={days.toString()} onValueChange={(v) => setDays(parseInt(v))}>
              <SelectTrigger className="w-[100px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button 
              onClick={handleAnalyze}
              disabled={analysisMutation.isPending}
              size="sm"
            >
              {analysisMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Analyze
                </>
              )}
            </Button>
          </div>
        </div>
        <CardDescription>
          Get AI-powered insights and actionable recommendations from user feedback
        </CardDescription>
      </CardHeader>
      <CardContent>
        {analysisMutation.isPending ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-32 w-full lg:col-span-2" />
          </div>
        ) : analysis ? (
          <ScrollArea className="h-[600px] pr-4">
            <div className="space-y-6">
              {/* Summary Card */}
              <div className="rounded-xl border bg-secondary/5 p-5">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-secondary/10">
                    <Target className="h-5 w-5 text-secondary" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold mb-2">Executive Summary</h4>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {analysis.analysis}
                    </p>
                    <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <MessageSquareQuote className="h-3.5 w-3.5" />
                        {analysis.feedback_analyzed_count} reviews analyzed
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Key Themes */}
              {analysis.key_themes.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
                    Key Themes
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {analysis.key_themes.map((theme, i) => (
                      <span 
                        key={i} 
                        className="px-3 py-1.5 rounded-full text-sm font-medium bg-secondary/10 text-secondary"
                      >
                        {theme}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Two Column Layout */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Positive Highlights */}
                {analysis.positive_highlights.length > 0 && (
                  <div className="rounded-xl border bg-secondary/5 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <CheckCircle2 className="h-5 w-5 text-secondary" />
                      <h4 className="font-semibold">What's Working</h4>
                    </div>
                    <ul className="space-y-2">
                      {analysis.positive_highlights.map((highlight, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          <span className="text-secondary mt-0.5 shrink-0">✓</span>
                          <span className="text-muted-foreground">{highlight}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Issues Summary */}
                {analysis.improvement_areas.length > 0 && (
                  <div className="rounded-xl border bg-destructive/5 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <AlertTriangle className="h-5 w-5 text-destructive" />
                      <h4 className="font-semibold">Needs Attention</h4>
                    </div>
                    <div className="space-y-2">
                      {analysis.improvement_areas.slice(0, 4).map((area, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm">
                          <div className={`w-2 h-2 rounded-full shrink-0 ${
                            area.severity === 'high' ? 'bg-destructive' : 'bg-secondary'
                          }`} />
                          <span className="text-muted-foreground truncate">{area.area}</span>
                          <span className="text-xs text-muted-foreground ml-auto shrink-0">{area.frequency}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Detailed Improvement Areas */}
              {analysis.improvement_areas.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
                    Improvement Details
                  </h4>
                  <div className="space-y-3">
                    {analysis.improvement_areas.map((area, i) => (
                      <div 
                        key={i} 
                        className={`rounded-lg border-l-4 p-4 ${getSeverityStyles(area.severity)}`}
                      >
                        <div className="flex items-start justify-between gap-4 mb-2">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-medium">{area.area}</span>
                              <Badge 
                                variant="outline" 
                                className={`text-[10px] uppercase ${
                                  area.severity === 'high' 
                                    ? 'border-destructive/50 text-destructive' 
                                    : 'border-secondary/50 text-secondary'
                                }`}
                              >
                                {area.severity}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">{area.suggested_action}</p>
                          </div>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">{area.frequency} mentions</span>
                        </div>
                        {area.user_quotes.length > 0 && (
                          <div className="mt-3 pl-3 border-l-2 border-muted">
                            {area.user_quotes.slice(0, 2).map((quote, qi) => (
                              <p key={qi} className="text-xs italic text-muted-foreground mb-1">
                                "{quote}"
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actionable Recommendations */}
              {analysis.actionable_recommendations.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">
                    Recommended Actions
                  </h4>
                  <div className="space-y-3">
                    {analysis.actionable_recommendations.map((rec, i) => (
                      <div 
                        key={i} 
                        className="group rounded-xl border bg-card p-4 hover:border-secondary/50 transition-colors"
                      >
                        <div className="flex items-start gap-4">
                          <div className={`p-2 rounded-lg shrink-0 ${
                            rec.priority === 'high' 
                              ? 'bg-destructive/10 text-destructive' 
                              : 'bg-secondary/10 text-secondary'
                          }`}>
                            {rec.priority === 'high' ? (
                              <Zap className="h-3.5 w-3.5" />
                            ) : (
                              <Lightbulb className="h-3.5 w-3.5" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <h5 className="font-medium text-sm">{rec.recommendation}</h5>
                              <div className="flex items-center gap-3 shrink-0">
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <span>Effort</span>
                                  {getEffortDots(rec.effort)}
                                </div>
                              </div>
                            </div>
                            <p className="text-sm text-muted-foreground mb-2">{rec.impact}</p>
                            <div className="flex items-center gap-1 text-xs text-secondary">
                              <ArrowRight className="h-3 w-3" />
                              <span>{rec.implementation_hint}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="h-[300px] flex flex-col items-center justify-center text-center border-2 border-dashed rounded-xl">
            <div className="p-4 rounded-full bg-secondary/10 mb-4">
              <Sparkles className="h-8 w-8 text-secondary/50" />
            </div>
            <p className="text-sm font-medium mb-1">
              Ready to analyze feedback
            </p>
            <p className="text-xs text-muted-foreground max-w-xs">
              Click "Analyze" to generate AI-powered insights using GPT-5 Nano
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
