'use client';

import { useEffect, useState } from 'react';
import { SectionHeader } from '@/components/home/section-header';
import { getAvailableModels, Model } from '@/lib/api';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';

interface PricingTableRowProps {
  model: Model;
  index: number;
}

function PricingTableRow({ model, index }: PricingTableRowProps) {
  return (
    <tr
      className="border-b border-border/50 transition-all duration-200 hover:bg-muted/30"
      style={{ animationDelay: `${index * 100}ms` }}
    >
      <td className="py-6 px-6">
        <div>
          <div className="font-semibold text-foreground capitalize">
            {model.display_name}
          </div>
          <div className="text-sm text-muted-foreground font-mono truncate max-w-[200px]">
            {model.id}
          </div>
        </div>
      </td>
      <td className="py-6 px-6 text-right">
        {model.input_cost_per_million_tokens !== null &&
        model.input_cost_per_million_tokens !== undefined ? (
          <>
            <div className="font-semibold text-foreground">
              ${model.input_cost_per_million_tokens.toFixed(2)}
            </div>
            <div className="text-sm text-muted-foreground">per 1M tokens</div>
          </>
        ) : (
          <div className="text-muted-foreground">—</div>
        )}
      </td>
      <td className="py-6 px-6 text-right">
        {model.output_cost_per_million_tokens !== null &&
        model.output_cost_per_million_tokens !== undefined ? (
          <>
            <div className="font-semibold text-foreground">
              ${model.output_cost_per_million_tokens.toFixed(2)}
            </div>
            <div className="text-sm text-muted-foreground">per 1M tokens</div>
          </>
        ) : (
          <div className="text-muted-foreground">—</div>
        )}
      </td>
    </tr>
  );
}

export default function PricingPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPricing = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await getAvailableModels();
        // Filter to only show models that have pricing information available
        const filteredModels = response.models.filter((model) => {
          return (
            model.input_cost_per_million_tokens !== null &&
            model.input_cost_per_million_tokens !== undefined &&
            model.output_cost_per_million_tokens !== null &&
            model.output_cost_per_million_tokens !== undefined
          );
        });
        setModels(filteredModels);
      } catch (err) {
        console.error('Error fetching model pricing:', err);

        // If there's an authentication error, show fallback data for the specific models requested
        if (
          err instanceof Error &&
          (err.message.includes('token') || err.message.includes('auth'))
        ) {
          const fallbackModels: Model[] = [
            {
              id: 'anthropic/claude-sonnet-4-20250514',
              display_name: 'Claude Sonnet 4',
              requires_subscription: true,
              is_available: false,
              input_cost_per_million_tokens: 3.0,
              output_cost_per_million_tokens: 15.0,
              max_tokens: 200000,
            },
            {
              id: 'openrouter/qwen/qwen3-235b-a22b',
              display_name: 'Qwen3 A22B',
              requires_subscription: false,
              is_available: false,
              input_cost_per_million_tokens: 0.4,
              output_cost_per_million_tokens: 0.4,
              max_tokens: 32768,
            },
            {
              id: 'openrouter/google/gemini-2.5-flash-preview-05-20',
              display_name: 'Gemini Flash 2.5',
              requires_subscription: false,
              is_available: false,
              input_cost_per_million_tokens: 0.075,
              output_cost_per_million_tokens: 0.3,
              max_tokens: 1000000,
            },
            {
              id: 'openrouter/deepseek/deepseek-chat',
              display_name: 'DeepSeek Chat',
              requires_subscription: false,
              is_available: false,
              input_cost_per_million_tokens: 0.14,
              output_cost_per_million_tokens: 0.28,
              max_tokens: 65536,
            },
          ];
          setModels(fallbackModels);
        } else {
          setError(
            err instanceof Error
              ? err.message
              : 'Failed to fetch model pricing',
          );
        }
      } finally {
        setLoading(false);
      }
    };

    fetchPricing();
  }, []);

  return (
    <div className="relative min-h-screen w-full">
      {/* Header */}
      <SectionHeader>
        <div className="text-center space-y-4">
          <div className="inline-flex items-center px-3 py-1.5 rounded-full border border-border bg-background/50 backdrop-blur-sm">
            <span className="text-sm font-medium text-muted-foreground">
              💰 MODEL PRICING
            </span>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent">
            AI Model Pricing
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Compare pricing across our supported AI models. All prices are shown
            per million tokens.
          </p>
        </div>
      </SectionHeader>

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6 py-12">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
              <p className="text-muted-foreground">Loading model pricing...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                <AlertCircle className="w-8 h-8 text-red-500" />
              </div>
              <div>
                <h3 className="text-xl font-semibold text-foreground mb-2">
                  Failed to load pricing
                </h3>
                <p className="text-muted-foreground mb-4">{error}</p>
                <Button
                  variant="outline"
                  onClick={() => window.location.reload()}
                  className="hover:bg-muted/50"
                >
                  Try Again
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Pricing Table */}
            <div className="border border-border rounded-xl bg-background/50 backdrop-blur-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left py-4 px-6 font-semibold text-foreground">
                        Model
                      </th>
                      <th className="text-right py-4 px-6 font-semibold text-foreground">
                        Input Cost
                      </th>
                      <th className="text-right py-4 px-6 font-semibold text-foreground">
                        Output Cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((model, index) => (
                      <PricingTableRow
                        key={model.id}
                        model={model}
                        index={index}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
