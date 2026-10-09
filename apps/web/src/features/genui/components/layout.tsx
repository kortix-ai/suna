'use client';

import { MarkdownImage, MarkdownLink } from '@/components/markdown/unified-markdown';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

import type { GenuiComponentProps, GenuiNode } from '../sdk';

export const kids = (value: unknown): GenuiNode[] => (Array.isArray(value) ? (value as GenuiNode[]) : []);

export function GenuiStack({ props, renderChild }: GenuiComponentProps) {
  const row = props.direction === 'row';
  return (
    <div className={cn(row ? 'flex flex-wrap gap-3 *:min-w-48 *:flex-1' : 'flex flex-col gap-4')}>
      {kids(props.children).map(renderChild)}
    </div>
  );
}

export function GenuiCard({ props, renderChild }: GenuiComponentProps) {
  const badges = kids(props.badges);
  const title = props.href ? <MarkdownLink href={props.href}>{props.title}</MarkdownLink> : props.title;
  return (
    // A standalone Card draws no frame. An in-flow tile takes one hairline and the default radius, like its siblings.
    <Card className="border-border bg-background rounded-md border">
      {props.image ? (
        <div className="px-4">
          <MarkdownImage src={props.image} alt="" />
        </div>
      ) : null}
      <CardHeader>
        <CardTitle className="text-balance">{title}</CardTitle>
        {props.subtitle ? <CardDescription className="text-pretty">{props.subtitle}</CardDescription> : null}
      </CardHeader>
      {props.body || badges.length > 0 ? (
        <CardContent className="flex flex-col gap-3">
          {props.body ? <p className="text-sm text-pretty">{props.body}</p> : null}
          {badges.length > 0 ? <div className="flex flex-wrap gap-1.5">{badges.map(renderChild)}</div> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

export function GenuiTabs({ props, renderChild, streaming }: GenuiComponentProps) {
  const tabs = kids(props.tabs);
  if (tabs.length === 0) return null;
  // While streaming, show the tab being written so progress is visible (spec §6.3).
  const value = streaming ? tabs[tabs.length - 1]!.id : undefined;
  return (
    <Tabs defaultValue={tabs[0]!.id} value={value} className="gap-3">
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {String(tab.props.label)}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="flex flex-col gap-4">
          {kids(tab.props.children).map(renderChild)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function GenuiAccordion({ props, renderChild }: GenuiComponentProps) {
  return (
    <Accordion type="multiple">
      {kids(props.items).map((item) => (
        <AccordionItem key={item.id} value={item.id}>
          <AccordionTrigger>{String(item.props.title)}</AccordionTrigger>
          <AccordionContent className="flex flex-col gap-3">{kids(item.props.children).map(renderChild)}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
