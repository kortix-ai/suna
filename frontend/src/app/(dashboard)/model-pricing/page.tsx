'use client';

import { SectionHeader } from '@/components/home/section-header';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAvailableModels } from '@/hooks/react-query/subscriptions/use-billing';
import type { Model } from '@/lib/api';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';

interface ModelCardProps {
  model: Model;
  index: number;
}

function ModelCard({ model, index }: ModelCardProps) {
  return (
    <div
      className="group relative bg-gradient-to-br from-background to-background/80 border border-border/50 rounded-2xl p-6 hover:border-border transition-all duration-300 hover:shadow-xl hover:shadow-black/5 hover:-translate-y-1"
      style={{ animationDelay: `${index * 100}ms` }}
    >
      <div className="space-y-4">
        {/* Model Header */}
        <div className="space-y-2">
          <h3 className="text-xl font-bold text-foreground group-hover:text-blue-600 transition-colors duration-300">
            {model.display_name}
          </h3>
        </div>

        {/* Pricing Grid */}
        <div className="grid grid-cols-2 gap-4">
          {/* Input Cost */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span className="text-sm font-medium text-muted-foreground">
                Input
              </span>
            </div>
            {model.input_cost_per_million_tokens !== null &&
            model.input_cost_per_million_tokens !== undefined ? (
              <>
                <div className="text-2xl font-bold text-foreground">
                  ${model.input_cost_per_million_tokens.toFixed(2)}
                </div>
                <div className="text-xs text-muted-foreground">
                  per 1M tokens
                </div>
              </>
            ) : (
              <div className="text-2xl font-bold text-muted-foreground">—</div>
            )}
          </div>

          {/* Output Cost */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
              <span className="text-sm font-medium text-muted-foreground">
                Output
              </span>
            </div>
            {model.output_cost_per_million_tokens !== null &&
            model.output_cost_per_million_tokens !== undefined ? (
              <>
                <div className="text-2xl font-bold text-foreground">
                  ${model.output_cost_per_million_tokens.toFixed(2)}
                </div>
                <div className="text-xs text-muted-foreground">
                  per 1M tokens
                </div>
              </>
            ) : (
              <div className="text-2xl font-bold text-muted-foreground">—</div>
            )}
          </div>
        </div>

        {/* Model Stats */}
        {model.max_tokens && (
          <div className="pt-4 border-t border-border/50">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Max Tokens</span>
              <span className="font-medium text-foreground">
                {model.max_tokens.toLocaleString()}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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

  return (
    <div className="relative min-h-screen w-full bg-gradient-to-br from-background via-background to-background/90">
      {/* Animated Background */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-50/20 via-transparent to-purple-50/20 dark:from-blue-950/20 dark:to-purple-950/20"></div>

      {/* Header */}
      <SectionHeader>
        <div className="text-center space-y-6">
          <div className="space-y-4">
            <h1 className="text-5xl md:text-6xl font-bold bg-gradient-to-br from-foreground via-foreground/90 to-foreground/70 bg-clip-text text-transparent">
              Compute Pricing
            </h1>
          </div>
        </div>
      </SectionHeader>

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6 pb-20 pt-4">
        {loading ? (
          <div className="flex items-center justify-center py-32">
            <div className="flex flex-col items-center gap-6">
              <div className="relative">
                <div className="w-16 h-16 border-4 border-blue-200 dark:border-blue-800 rounded-full animate-spin border-t-blue-500"></div>
                <div className="absolute inset-0 w-16 h-16 border-4 border-transparent rounded-full animate-ping border-t-blue-500/20"></div>
              </div>
              <div className="text-center">
                <p className="text-lg font-medium text-foreground">
                  Loading compute pricing
                </p>
                <p className="text-sm text-muted-foreground">
                  Fetching the latest pricing data...
                </p>
              </div>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-32">
            <div className="max-w-md text-center space-y-6">
              <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-red-50 to-red-100 dark:from-red-950/50 dark:to-red-900/50 border border-red-200 dark:border-red-800 flex items-center justify-center">
                <AlertCircle className="w-10 h-10 text-red-500" />
              </div>
              <div className="space-y-3">
                <h3 className="text-2xl font-bold text-foreground">
                  Pricing Unavailable
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                  {error instanceof Error
                    ? error.message
                    : 'Failed to fetch model pricing'}
                </p>
              </div>
              <Button
                onClick={() => refetch()}
                className="bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white border-0 shadow-lg hover:shadow-xl transition-all duration-300"
              >
                <Loader2 className="w-4 h-4 mr-2" />
                Try Again
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-12">
            {/* Model Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {models.map((model, index) => (
                <ModelCard key={model.id} model={model} index={index} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
