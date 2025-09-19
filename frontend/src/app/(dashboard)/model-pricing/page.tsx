'use client';

import { AlertCircle, Zap, Server, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAvailableModels } from '@/hooks/react-query/subscriptions/use-billing';
import type { Model } from '@/lib/api';
import { Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useModelSelection } from '@/components/thread/chat-input/_use-model-selection';

// Example task data with token usage
const exampleTasks = [
  {
    name: 'Social Automation System',
    complexity: 'Complex',
    complexityVariant: 'destructive' as const,
    inputTokens: 3410337,
    outputTokens: 93616,
    duration: '35 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Content Marketing Strategy',
    complexity: 'Standard Complexity',
    complexityVariant: 'secondary' as const,
    inputTokens: 212312,
    outputTokens: 3378,
    duration: '11 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Go-to-Market Strategy',
    complexity: 'Standard Complexity',
    complexityVariant: 'secondary' as const,
    inputTokens: 307719,
    outputTokens: 24033,
    duration: '16 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Learning Path Generator',
    complexity: 'Standard Complexity',
    complexityVariant: 'secondary' as const,
    inputTokens: 90953,
    outputTokens: 17472,
    duration: '5 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Customer Journey Mapping',
    complexity: 'Complex',
    complexityVariant: 'destructive' as const,
    inputTokens: 360013,
    outputTokens: 17287,
    duration: '20 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Sales Funnel Optimization',
    complexity: 'Complex',
    complexityVariant: 'destructive' as const,
    inputTokens: 559918,
    outputTokens: 33392,
    duration: '14 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Startup Pitch Deck',
    complexity: 'Standard Complexity',
    complexityVariant: 'secondary' as const,
    inputTokens: 169175,
    outputTokens: 10263,
    duration: '5 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Health Tracking Dashboard',
    complexity: 'Standard Complexity',
    complexityVariant: 'secondary' as const,
    inputTokens: 110952,
    outputTokens: 5639,
    duration: '3 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Recommendation Engine',
    complexity: 'Complex',
    complexityVariant: 'destructive' as const,
    inputTokens: 4220364,
    outputTokens: 21733,
    duration: '25 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Automated ETL Pipeline',
    complexity: 'Complex',
    complexityVariant: 'destructive' as const,
    inputTokens: 2513197,
    outputTokens: 78438,
    duration: '32 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Automated Code Reviewer',
    complexity: 'Complex',
    complexityVariant: 'destructive' as const,
    inputTokens: 1707944,
    outputTokens: 79117,
    duration: '29 minutes',
    originalModel: 'claude-sonnet-4',
  },
  {
    name: 'Risk Assessment',
    complexity: 'Complex',
    complexityVariant: 'destructive' as const,
    inputTokens: 693487,
    outputTokens: 43371,
    duration: '15 minutes',
    originalModel: 'claude-sonnet-4',
  },
];

const DISABLE_EXAMPLES = true;

export default function PricingPage() {
  const {
    data: modelsResponse,
    isLoading: loading,
    error,
    refetch,
  } = useAvailableModels();

  const { allModels } = useModelSelection();

  const [selectedModelId, setSelectedModelId] = useState<string>(
    'anthropic/claude-sonnet-4-20250514',
  );
  const [showAllTasks, setShowAllTasks] = useState<boolean>(false);

  // Filter to only show models that have pricing information available and sort by display name order
  const models = useMemo(() => {
    const filteredModels =
      modelsResponse?.models?.filter((model: Model) => {
        return (
          model.input_cost_per_million_tokens !== null &&
          model.input_cost_per_million_tokens !== undefined &&
          model.output_cost_per_million_tokens !== null &&
          model.output_cost_per_million_tokens !== undefined
        );
      }) || [];

    return filteredModels
      .map((v) => ({
        ...v,
        display_name: allModels.find((m) => m.id === v.short_name)?.label,
        priority: allModels.find((m) => m.id === v.short_name)?.priority,
        requiresSubscription: allModels.find((m) => m.id === v.short_name)?.requiresSubscription,
      }))
      .sort((a, b) => {
        // First by free/premium status (premium first)
        if (a.requiresSubscription !== b.requiresSubscription) {
          return a.requiresSubscription ? -1 : 1;
        }

        // Then by priority (higher first)
        if ((a.priority ?? 0) !== (b.priority ?? 0)) {
          return (b.priority ?? 0) - (a.priority ?? 0);
        }
        
        // Finally by name (alphabetical)
        return (a.display_name ?? a.id).localeCompare(b.display_name ?? b.id);
      });
  }, [modelsResponse?.models, allModels]);

  // Find the selected model
  const selectedModel = models.find((model) => model.id === selectedModelId);

  // Function to calculate cost based on tokens and model pricing
  const calculateCost = (
    inputTokens: number,
    outputTokens: number,
    model: Model,
  ) => {
    if (
      !model.input_cost_per_million_tokens ||
      !model.output_cost_per_million_tokens
    ) {
      return 0;
    }

    const inputCost =
      (inputTokens / 1000000) * model.input_cost_per_million_tokens;
    const outputCost =
      (outputTokens / 1000000) * model.output_cost_per_million_tokens;

    return inputCost + outputCost;
  };

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
        <h1 className="text-3xl font-bold text-foreground">Token Pricing</h1>
        <p className="text-lg text-muted-foreground max-w-3xl">
          Understand how tokens work, explore pricing for AI models, and find
          the right plan for your needs.
        </p>
      </div>

      {/* What are Tokens Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-blue-500" />
            Understanding Tokens & Compute
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Tokens are the fundamental units that AI models use to process text
            - the more complex or lengthy your task, the more tokens it
            requires. Compute usage is measured by both input tokens (your
            prompts and context) and output tokens (the AI's responses), with
            different models having varying computational requirements and costs
            per token.
          </p>
        </CardContent>
      </Card>

      {/* How Pricing Works Section */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="w-5 h-5 text-green-500" />
            How does pricing work?
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Usage costs are calculated based on token consumption from AI model
            interactions. We apply a 50% markup over direct model provider costs
            to maintain our platform and services. Your total cost depends on
            the specific model used and the number of tokens processed for both
            input (prompts, context) and output (generated responses).
          </p>
        </CardContent>
      </Card>

      {/* Usage Examples Section */}
      {!DISABLE_EXAMPLES && (
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
            <div className="space-y-6">
              {/* Model Selection */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  Select a model to see pricing:
                </label>
                <Select
                  value={selectedModelId}
                  onValueChange={setSelectedModelId}
                >
                  <SelectTrigger className="w-full max-w-md">
                    <SelectValue placeholder="Choose a model to calculate costs" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Example Tasks Grid */}
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {(showAllTasks ? exampleTasks : exampleTasks.slice(0, 3)).map(
                  (task, index) => {
                    const calculatedCost = selectedModel
                      ? calculateCost(
                          task.inputTokens,
                          task.outputTokens,
                          selectedModel,
                        )
                      : null;

                    return (
                      <div
                        key={index}
                        className="p-4 border border-border rounded-lg space-y-3"
                      >
                        <div className="space-y-2">
                          <h4 className="font-semibold text-foreground">
                            {task.name}
                          </h4>
                        </div>
                        <div className="space-y-2 text-sm mt-6">
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">
                              Model:
                            </span>
                            <span>
                              {selectedModel?.display_name ||
                                task.originalModel}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">
                              Input Tokens:
                            </span>
                            <span>{task.inputTokens.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-muted-foreground">
                              Output Tokens:
                            </span>
                            <span>{task.outputTokens.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between font-semibold">
                            <span className="text-muted-foreground">Cost:</span>
                            {calculatedCost !== null ? (
                              <span className="text-blue-600">
                                ${calculatedCost.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                Select model above
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  },
                )}
              </div>

              {/* Show More/Less Button */}
              {exampleTasks.length > 3 && (
                <div className="flex justify-center mt-6">
                  <Button
                    variant="outline"
                    onClick={() => setShowAllTasks(!showAllTasks)}
                    className="gap-2"
                  >
                    {showAllTasks ? 'Show Less' : `Show More`}
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Compute Pricing by Model</CardTitle>
          <CardDescription>
            Detailed pricing information for available AI models. We apply a 20%
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
                  className={`px-6 py-4 hover:bg-muted/50 transition-colors duration-150 ${
                    selectedModelId === model.id
                      ? 'bg-blue-50 dark:bg-blue-950/20 border-l-4 border-l-blue-500'
                      : ''
                  }`}
                >
                  <div className="grid grid-cols-3 gap-4 items-center">
                    {/* Model Name */}
                    <div className="col-span-1">
                      <div className="flex items-center gap-3">
                        <div className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0"></div>
                        <div className="min-w-0">
                          <div className="font-medium text-foreground truncate">
                            {model.display_name ?? model.id}
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
