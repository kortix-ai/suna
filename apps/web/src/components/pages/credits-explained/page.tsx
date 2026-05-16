'use client';

import { Zap, Clock, Sparkles, Info, RotateCcw, Infinity, DollarSign } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTranslations } from 'next-intl';

export default function CreditsPage() {
  const t = useTranslations('billing.creditsExplainedPage');

  return (
    <div className="container mx-auto max-w-4xl px-3 sm:px-4 py-4 sm:py-8 md:py-12">
      {/* Header Section */}
      <div className="space-y-2 sm:space-y-3 mb-6 sm:mb-10">
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p className="text-base sm:text-lg text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      <div className="space-y-10">
        {/* Introduction */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('understandingCredits.title')}</h2>
          </div>
          <p className="text-muted-foreground leading-relaxed text-base">
            {t('understandingCredits.description')}
          </p>
        </div>

        {/* How Credits Work */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('howCreditsWork.title')}</h2>
          </div>
          
          <p className="text-muted-foreground leading-relaxed">
            {t('howCreditsWork.description')}
          </p>

          <Card>
            <CardContent className="pt-6">
              <ul className="space-y-3 text-muted-foreground">
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">AI activity:</span> Processing requests, generating responses, making decisions, and running AI models during task execution.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Kortix computer:</span> The execution environment that powers code execution, browser automation, and interactive task processing.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">File storage and management:</span> Storing, organizing, and managing files created during your tasks.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Web search:</span> Searching the internet for information, data, and resources needed to complete tasks.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">People search:</span> Finding and retrieving information about people, contacts, and professional data.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Third-party services:</span> Accessing external APIs, databases, and integrated services that extend your agent's capabilities.
                  </div>
                </li>
              </ul>
              <div className="mt-6 pt-6 border-t border-border">
                <p className="text-muted-foreground leading-relaxed">
                  Once a task completes, no further credits are consumed. Your completed work, stored files, and deployed projects remain accessible without any ongoing credit costs.
                </p>
              </div>
              <Alert className="mt-4">
                <Info className="h-4 w-4" />
                <AlertDescription>
                  If a task fails due to a system error on our side, we'll automatically refund all credits used for that task. We're constantly improving our infrastructure to make credit usage more efficient.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>

        {/* Pricing Model */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('howCreditsWork.pricingModel.title')}</h2>
          </div>
          
          <p className="text-muted-foreground leading-relaxed">
            We apply a markup on top of provider costs to cover platform infrastructure, security, and ongoing development. Rates vary by service type:
          </p>

          <Card>
            <CardContent className="pt-6">
              <ul className="space-y-3 text-muted-foreground">
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">AI models (20% markup):</span> Applied to all LLM API costs including input tokens, output tokens, and prompt caching.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Tool usage (50% markup):</span> Applied to web search, web scraping, and other third-party tool calls.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Image search (100% markup):</span> Applied to image search queries.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Bring your own key (10% platform fee):</span> If you use your own API key, a flat 10% fee applies instead of the standard AI model markup.
                  </div>
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>

        {/* Types of Credits */}
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">{t('typesOfCredits.title')}</h2>
          </div>

          <p className="text-muted-foreground leading-relaxed">
            Credits are used to pay for LLM calls and tool usage. You get credits from purchases, auto-topup, and a one-time bonus when you provision a machine.
          </p>

          {/* Credit Types Visual Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Machine Bonus */}
            <Card className="border-blue-500/20 bg-gradient-to-br from-blue-500/5 to-transparent">
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 mb-3">
                  <RotateCcw className="h-5 w-5 text-blue-500" />
                  <h3 className="font-semibold text-foreground">Machine Bonus</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  500 credits ($5) granted one-time when you provision a new cloud computer. These never expire.
                </p>
              </CardContent>
            </Card>

            {/* Purchased Credits */}
            <Card className="border-orange-500/20 bg-gradient-to-br from-orange-500/5 to-transparent">
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 mb-3">
                  <Clock className="h-5 w-5 text-orange-500" />
                  <h3 className="font-semibold text-foreground">Purchased</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Buy credit packs ($10–$500) or enable auto-topup to never run out. Purchased credits never expire.
                </p>
              </CardContent>
            </Card>

            {/* Legacy Monthly */}
            <Card className="border-border">
              <CardContent className="pt-5">
                <div className="flex items-center gap-2 mb-3">
                  <Infinity className="h-5 w-5 text-muted-foreground" />
                  <h3 className="font-semibold text-foreground">Monthly (Legacy)</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Some legacy plans include monthly credits that refresh each billing cycle. These don't roll over.
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-foreground mb-3">How you get credits</h3>
              <div className="space-y-3 text-muted-foreground">
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Machine bonus:</span> Every new cloud computer comes with 500 credits ($5) as a one-time welcome bonus.
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-orange-500 mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Credit purchases:</span> Buy packs of credits anytime. Available in $10, $25, $50, $100, $250, and $500 denominations.
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                  <div>
                    <span className="font-medium text-foreground">Auto-topup:</span> Automatically recharge when your balance gets low. Enabled by default — configure threshold and amount in settings.
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Priority Order Info */}
          <Alert className="border-blue-500/20 bg-blue-500/5">
            <Info className="h-4 w-4" />
            <AlertDescription>
              <strong>Credit usage:</strong> Credits are deducted per LLM token used and per tool call. Costs vary by model — more capable models cost more per token.
            </AlertDescription>
          </Alert>
        </div>

      </div>
    </div>
  );
}
