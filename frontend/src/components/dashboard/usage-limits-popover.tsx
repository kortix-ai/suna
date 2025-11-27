'use client';

import React from 'react';
import { Button } from '@/components/ui/button';
import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { useTranslations } from 'next-intl';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useLimits } from '@/hooks/dashboard/use-limits';

export function UsageLimitsPopover() {
  const t = useTranslations('dashboard');
  const { data: limits } = useLimits();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size='icon' variant='outline'>
          <Info className='h-4 w-4'/>
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className="w-80">
        <TooltipProvider>
          <div>
            <h2 className="text-md font-medium mb-4">{t('usageLimits')}</h2>
            <div className="space-y-3">
              <div className='space-y-2'>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex justify-between text-xs cursor-help">
                      <span className="text-muted-foreground">Chats</span>
                      <span className="font-medium">{limits?.thread_count?.current_count || 0} / {limits?.thread_count?.limit || 0}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Total conversations with your AI Workers</p>
                  </TooltipContent>
                </Tooltip>
                <Progress 
                  className='h-1'
                  value={((limits?.thread_count?.current_count || 0) / (limits?.thread_count?.limit || 1)) * 100} 
                />
              </div>
              <div className='space-y-2'>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex justify-between text-xs cursor-help">
                      <span className="text-muted-foreground">Concurrent Runs</span>
                      <span className="font-medium">{limits?.concurrent_runs?.running_count || 0} / {limits?.concurrent_runs?.limit || 0}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">AI Workers running at the same time</p>
                  </TooltipContent>
                </Tooltip>
                <Progress 
                  className='h-1'
                  value={((limits?.concurrent_runs?.running_count || 0) / (limits?.concurrent_runs?.limit || 1)) * 100} 
                />
              </div>
              <div className='space-y-2'>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex justify-between text-xs cursor-help">
                      <span className="text-muted-foreground">Custom AI Workers</span>
                      <span className="font-medium">{(limits?.ai_worker_count?.current_count ?? limits?.agent_count?.current_count) || 0} / {(limits?.ai_worker_count?.limit ?? limits?.agent_count?.limit) || 0}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Create personalized AI Workers with custom instructions</p>
                  </TooltipContent>
                </Tooltip>
                <Progress 
                  className='h-1'
                  value={((((limits?.ai_worker_count?.current_count ?? limits?.agent_count?.current_count) || 0) / (((limits?.ai_worker_count?.limit ?? limits?.agent_count?.limit) || 1))) * 100)} 
                />
              </div>
              <div className='space-y-2'>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex justify-between text-xs cursor-help">
                      <span className="text-muted-foreground">Integrations</span>
                      <span className="font-medium">{(limits?.custom_mcp_count?.current_count ?? limits?.custom_worker_count?.current_count) || 0} / {(limits?.custom_mcp_count?.limit ?? limits?.custom_worker_count?.limit) || 0}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Add external tool integrations and APIs</p>
                  </TooltipContent>
                </Tooltip>
                <Progress 
                  className='h-1'
                  value={((((limits?.custom_mcp_count?.current_count ?? limits?.custom_worker_count?.current_count) || 0) / (((limits?.custom_mcp_count?.limit ?? limits?.custom_worker_count?.limit) || 1))) * 100)} 
                />
              </div>
              <div className='space-y-2'>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex justify-between text-xs cursor-help">
                      <span className="text-muted-foreground">Scheduled Triggers</span>
                      <span className="font-medium">{limits?.trigger_count?.scheduled?.current_count || 0} / {limits?.trigger_count?.scheduled?.limit || 0}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Time-based automation (daily, weekly, hourly runs)</p>
                  </TooltipContent>
                </Tooltip>
                <Progress 
                  className='h-1'
                  value={((limits?.trigger_count?.scheduled?.current_count || 0) / (limits?.trigger_count?.scheduled?.limit || 1)) * 100} 
                />
              </div>
              <div className='space-y-2'>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex justify-between text-xs cursor-help">
                      <span className="text-muted-foreground">App Triggers</span>
                      <span className="font-medium">{limits?.trigger_count?.app?.current_count || 0} / {limits?.trigger_count?.app?.limit || 0}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">Event-based automation (new email, CRM entry, Notion page, etc.)</p>
                  </TooltipContent>
                </Tooltip>
                <Progress 
                  className='h-1'
                  value={((limits?.trigger_count?.app?.current_count || 0) / (limits?.trigger_count?.app?.limit || 1)) * 100} 
                />
              </div>
            </div>
          </div>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
}

