import type { StreamTaskChunk } from '../slack-api';

const ADAPTIVE_CARD_VERSION = '1.5';

type CardElement = Record<string, unknown>;

const STATUS_GLYPH: Record<string, string> = {
  pending: '•',
  in_progress: '⏳',
  complete: '✓',
  error: '✗',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  in_progress: 'accent',
  complete: 'good',
  error: 'attention',
};

function card(body: CardElement[]): Record<string, unknown> {
  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: ADAPTIVE_CARD_VERSION,
    body,
  };
}

function stepElements(step: StreamTaskChunk): CardElement[] {
  const glyph = STATUS_GLYPH[step.status] ?? '•';
  const color = STATUS_COLOR[step.status] ?? 'default';
  const out: CardElement[] = [
    {
      type: 'TextBlock',
      text: `${glyph} ${step.title}`,
      wrap: true,
      color,
      weight: step.status === 'in_progress' ? 'bolder' : 'default',
    },
  ];
  if (step.details) {
    out.push({ type: 'TextBlock', text: step.details, wrap: true, isSubtle: true, spacing: 'none', size: 'small' });
  }
  if (step.output) {
    out.push({ type: 'TextBlock', text: step.output, wrap: true, isSubtle: true, spacing: 'none', size: 'small' });
  }
  return out;
}

function planContainer(title: string, steps: StreamTaskChunk[]): CardElement[] {
  const elements: CardElement[] = [
    { type: 'TextBlock', text: title, weight: 'bolder', size: 'medium', wrap: true },
  ];
  for (const step of steps) elements.push(...stepElements(step));
  return elements;
}

export function buildPlanCard(title: string, steps: StreamTaskChunk[]): Record<string, unknown> {
  return card(planContainer(title, steps));
}

export function buildFinalCard(opts: {
  title: string;
  steps: StreamTaskChunk[];
  body?: string;
  sessionUrl?: string;
}): Record<string, unknown> {
  const elements: CardElement[] = planContainer(opts.title, opts.steps);
  if (opts.body) {
    elements.push({ type: 'TextBlock', text: opts.body, wrap: true, spacing: 'medium' });
  }
  if (opts.sessionUrl) {
    elements.push({
      type: 'TextBlock',
      text: `[Open session in Kortix ↗](${opts.sessionUrl})`,
      wrap: true,
      isSubtle: true,
      size: 'small',
      spacing: 'medium',
    });
  }
  return card(elements);
}

export function buildAnswerCard(body: string, sessionUrl?: string): Record<string, unknown> {
  const elements: CardElement[] = [{ type: 'TextBlock', text: body, wrap: true }];
  if (sessionUrl) {
    elements.push({
      type: 'TextBlock',
      text: `[Open session in Kortix ↗](${sessionUrl})`,
      wrap: true,
      isSubtle: true,
      size: 'small',
      spacing: 'medium',
    });
  }
  return card(elements);
}
