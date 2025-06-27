'use client';

import { SectionHeader } from '@/components/home/section-header';
import {
  AlertCircle,
  Clock,
  DollarSign,
  Zap,
  Server,
  Globe,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAvailableModels } from '@/hooks/react-query/subscriptions/use-billing';
import type { Model } from '@/lib/api';
import { Loader2 } from 'lucide-react';

export default function PricingPage() {
  const {
    data: modelsResponse,
    isLoading: loading,
    error,
    refetch,
  } = useAvailableModels();

  // Filter to only show models that have pricing information available
  const models =
    modelsResponse?.models?.filter((model: Model) => {
      return (
        model.input_cost_per_million_tokens !== null &&
        model.input_cost_per_million_tokens !== undefined &&
        model.output_cost_per_million_tokens !== null &&
        model.output_cost_per_million_tokens !== undefined
      );
    }) || [];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <p className="text-sm text-muted-foreground">
            Loading pricing data...
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="max-w-md text-center space-y-4">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto" />
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground">
              Pricing Unavailable
            </h3>
            <p className="text-sm text-muted-foreground">
              {error instanceof Error
                ? error.message
                : 'Failed to fetch model pricing'}
            </p>
          </div>
          <Button onClick={() => refetch()} size="sm">
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-8 max-w-4xl mx-auto">
      {/* Header Section */}
      <div className="space-y-4">
        <h1 className="text-3xl font-bold text-foreground">
          Credits & Pricing
        </h1>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Understand how credits work, explore pricing for AI models, and find
          the right plan for your needs.
        </p>
      </div>

      {/* What are Credits Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-blue-500" />
            What are credits?
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Credits are our standard unit of measurement for platform usage -
            the more complex or lengthy the task, the more credits it requires.
            Credits provide a unified way to measure consumption across
            different types of AI operations and computational resources.
          </p>
        </CardContent>
      </Card>

      {/* How Credits Work Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="w-5 h-5 text-green-500" />
            How do credits work?
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Credits are consumed based on AI model usage. We apply a 50% markup
            over the direct model provider costs. The specific credits
            consumption is determined by the model used and the number of tokens
            processed (both input and output tokens).
          </p>
        </CardContent>
      </Card>

      {/* Usage Examples Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-orange-500" />
            Usage Examples
          </CardTitle>
          <CardDescription>
            Here are some examples demonstrating credits consumption across
            different task types and complexity levels.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {/* Example 4 */}
            <div className="p-4 border border-border rounded-lg space-y-3">
              <div className="space-y-2">
                <h4 className="font-semibold text-foreground">
                  Social Automation System
                </h4>
                <Badge variant="destructive">Complex</Badge>
              </div>
              <div className="space-y-2 text-sm mt-6">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Model:</span>
                  <span>claude-sonnet-4</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration:</span>
                  <span>35 minutes</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span className="text-muted-foreground">Cost:</span>
                  <span className="text-blue-600">$17.45</span>
                </div>
              </div>
            </div>

            {/* Example 6 */}
            <div className="p-4 border border-border rounded-lg space-y-3">
              <div className="space-y-2">
                <h4 className="font-semibold text-foreground">
                  Content Marketing Strategy
                </h4>
                <Badge variant="secondary">Standard Complexity</Badge>
              </div>
              <div className="space-y-2 text-sm mt-6">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Model:</span>
                  <span>claude-sonnet-4</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration:</span>
                  <span>11 minutes</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span className="text-muted-foreground">Cost:</span>
                  <span className="text-blue-600">$1.93</span>
                </div>
              </div>
            </div>

            {/* Example 5 */}
            <div className="p-4 border border-border rounded-lg space-y-3">
              <div className="space-y-2">
                <h4 className="font-semibold text-foreground">
                  Go-to-Market Strategy
                </h4>
                <Badge variant="secondary">Standard Complexity</Badge>
              </div>
              <div className="space-y-2 text-sm mt-6">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Model:</span>
                  <span>deepseek-chat</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration:</span>
                  <span>3 minutes</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span className="text-muted-foreground">Cost:</span>
                  <span className="text-blue-600">$0.13</span>
                </div>
              </div>
            </div>

            {/* Example 7 */}
            {/* <div className="p-4 border border-border rounded-lg space-y-3">
              <div className="space-y-2">
                <h4 className="font-semibold text-foreground">
                  6-Month Content Marketing Strategy
                </h4>
                <Badge variant="secondary">Standard Complexity</Badge>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Task type:</span>
                  <span>Marketing • SEO • Content</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Model:</span>
                  <span>deepseek-chat</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration:</span>
                  <span>4 minutes</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span className="text-muted-foreground">Cost:</span>
                  <span className="text-blue-600">$0.20</span>
                </div>
              </div>
            </div> */}
          </div>
        </CardContent>
      </Card>

      {/* Model Pricing Table */}
      <Card>
        <CardHeader>
          <CardTitle>Compute Pricing by Model</CardTitle>
          <CardDescription>
            Detailed pricing information for available AI models. We apply a 50%
            markup on direct LLM provider costs to maintain our service and
            generate profit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-card border border-border rounded-lg">
            <div className="px-6 py-4 border-b border-border">
              <div className="grid grid-cols-3 gap-4 text-sm font-medium text-muted-foreground">
                <div className="col-span-1">Model</div>
                <div className="col-span-1 text-center">Input Cost</div>
                <div className="col-span-1 text-center">Output Cost</div>
              </div>
            </div>

            <div className="divide-y divide-border">
              {models.map((model, index) => (
                <div
                  key={model.id}
                  className="px-6 py-4 hover:bg-muted/50 transition-colors duration-150"
                >
                  <div className="grid grid-cols-3 gap-4 items-center">
                    {/* Model Name */}
                    <div className="col-span-1">
                      <div className="flex items-center gap-3">
                        <div className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0"></div>
                        <div className="min-w-0">
                          <div className="font-medium text-foreground truncate">
                            {model.display_name}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Input Cost */}
                    <div className="col-span-1 text-center">
                      <div className="space-y-1">
                        {model.input_cost_per_million_tokens !== null &&
                        model.input_cost_per_million_tokens !== undefined ? (
                          <>
                            <div className="font-semibold text-foreground">
                              ${model.input_cost_per_million_tokens.toFixed(2)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              per 1M tokens
                            </div>
                          </>
                        ) : (
                          <div className="font-semibold text-muted-foreground">
                            —
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Output Cost */}
                    <div className="col-span-1 text-center">
                      <div className="space-y-1">
                        {model.output_cost_per_million_tokens !== null &&
                        model.output_cost_per_million_tokens !== undefined ? (
                          <>
                            <div className="font-semibold text-foreground">
                              ${model.output_cost_per_million_tokens.toFixed(2)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              per 1M tokens
                            </div>
                          </>
                        ) : (
                          <div className="font-semibold text-muted-foreground">
                            —
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
