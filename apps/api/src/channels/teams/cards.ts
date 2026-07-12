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

function card(body: CardElement[], actions?: CardElement[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: ADAPTIVE_CARD_VERSION,
    body,
  };
  if (actions && actions.length) out.actions = actions;
  return out;
}

function openUrlAction(title: string, url: string): CardElement {
  return { type: 'Action.OpenUrl', title, url };
}

function executeAction(title: string, verb: string, data: Record<string, unknown> = {}): CardElement {
  return { type: 'Action.Execute', title, verb, data: { verb, ...data } };
}

function text(value: string, extra: CardElement = {}): CardElement {
  return { type: 'TextBlock', text: value, wrap: true, ...extra };
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

export function buildConnectAccountCard(loginUrl: string): Record<string, unknown> {
  return card(
    [text('Connect a Kortix account to let me run from Teams.', { weight: 'bolder', size: 'medium' })],
    [openUrlAction('Connect or create account', loginUrl)],
  );
}

export function buildRequestAccessCard(projectId: string): Record<string, unknown> {
  return card(
    [text("You're connected, but your account doesn't have access to this project yet.", { weight: 'bolder' })],
    [executeAction('Request access', 'teams_request_access', { projectId })],
  );
}

export function buildNoticeCard(body: string): Record<string, unknown> {
  return card([text(body, { wrap: true })]);
}

export function buildChoiceCard(opts: {
  title: string;
  verb: string;
  choices: Array<{ title: string; data: Record<string, unknown> }>;
  body?: string;
}): Record<string, unknown> {
  const elements: CardElement[] = [text(opts.title, { weight: 'bolder', size: 'medium' })];
  if (opts.body) elements.push(text(opts.body, { isSubtle: true, size: 'small', spacing: 'none' }));
  const actions = opts.choices.slice(0, 6).map((c) => executeAction(c.title, opts.verb, c.data));
  return card(elements, actions);
}

export function buildPanelCard(opts: {
  title: string;
  rows: Array<{ label: string; value: string }>;
  url?: string;
}): Record<string, unknown> {
  const facts = opts.rows.map((r) => ({ title: r.label, value: r.value }));
  const elements: CardElement[] = [
    text(opts.title, { weight: 'bolder', size: 'medium' }),
    { type: 'FactSet', facts },
  ];
  const actions = opts.url ? [openUrlAction('Open in Kortix', opts.url)] : undefined;
  return card(elements, actions);
}

export function buildQuestionCard(
  questions: Array<{ question: string; options?: Array<{ label: string }> }>,
): Record<string, unknown> {
  const elements: CardElement[] = [];
  for (const q of questions) {
    elements.push(text(q.question, { weight: 'bolder', wrap: true }));
  }
  const options = questions.flatMap((q) => q.options ?? []);
  const seen = new Set<string>();
  const actions: CardElement[] = [];
  for (const o of options) {
    if (!o.label || seen.has(o.label)) continue;
    seen.add(o.label);
    actions.push(executeAction(o.label, 'teams_answer', { answer: o.label }));
    if (actions.length >= 6) break;
  }
  elements.push(text('Tap an option or just reply in the chat.', { isSubtle: true, size: 'small', spacing: 'small' }));
  return card(elements, actions.length ? actions : undefined);
}

export function buildWelcomeCard(opts: { projectUrl?: string }): Record<string, unknown> {
  const elements: CardElement[] = [
    text('Kortix is connected here', { weight: 'bolder', size: 'medium' }),
    text('@-mention me with a task and an agent gets on it, replying right here with live progress. Type `/help` to see what I can do.'),
  ];
  const actions = opts.projectUrl ? [openUrlAction('Open in Kortix', opts.projectUrl)] : undefined;
  return card(elements, actions);
}

export function buildHelpCard(commands: Array<{ cmd: string; desc: string }>): Record<string, unknown> {
  const elements: CardElement[] = [text('Kortix commands', { weight: 'bolder', size: 'medium' })];
  for (const c of commands) {
    elements.push(text(`**${c.cmd}** — ${c.desc}`, { spacing: 'none', size: 'small' }));
  }
  return card(elements);
}
