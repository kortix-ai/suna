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

function headerBlock(emoji: string, title: string, subtitle?: string): CardElement[] {
  const els: CardElement[] = [text(`${emoji}  ${title}`, { size: 'large', weight: 'bolder', spacing: 'none' })];
  if (subtitle) els.push(text(subtitle, { isSubtle: true, size: 'small', spacing: 'small' }));
  return els;
}

function emphasisContainer(items: CardElement[]): CardElement {
  return { type: 'Container', style: 'emphasis', spacing: 'medium', bleed: true, items };
}

export function buildConnectAccountCard(loginUrl: string): Record<string, unknown> {
  return card(
    headerBlock(
      '🔗',
      'Connect your Kortix account',
      'Link once so I run as you — your own credentials, secrets and connected apps, never the installer’s.',
    ),
    [openUrlAction('Connect or create account', loginUrl)],
  );
}

export function buildRequestAccessCard(projectId: string): Record<string, unknown> {
  return card(
    headerBlock('🔒', 'Request access', "You're connected, but your account can't run this project yet."),
    [executeAction('Request access', 'teams_request_access', { projectId })],
  );
}

export function buildNoticeCard(body: string, emoji = ''): Record<string, unknown> {
  return card([text(emoji ? `${emoji}  ${body}` : body, { wrap: true })]);
}

export interface SelectOption {
  label: string;
  hint?: string;
  current?: boolean;
  data: Record<string, unknown>;
}

function selectRow(o: SelectOption, verb: string, separator: boolean): CardElement {
  const labelItems: CardElement[] = [
    text(o.label, { weight: o.current ? 'bolder' : 'default', spacing: 'none', color: o.current ? 'good' : 'default' }),
  ];
  if (o.hint) labelItems.push(text(o.hint, { isSubtle: true, size: 'small', spacing: 'none' }));
  return {
    type: 'ColumnSet',
    separator,
    spacing: 'medium',
    columns: [
      { type: 'Column', width: 'stretch', verticalContentAlignment: 'center', items: labelItems },
      {
        type: 'Column',
        width: 'auto',
        verticalContentAlignment: 'center',
        items: [
          {
            type: 'ActionSet',
            actions: [
              {
                type: 'Action.Execute',
                title: o.current ? '✓ In use' : 'Use',
                verb,
                data: { verb, ...o.data },
                ...(o.current ? {} : { style: 'positive' }),
              },
            ],
          },
        ],
      },
    ],
  };
}

export function buildSelectCard(opts: {
  emoji: string;
  title: string;
  subtitle?: string;
  verb: string;
  options: SelectOption[];
  footer?: string;
}): Record<string, unknown> {
  const body: CardElement[] = [...headerBlock(opts.emoji, opts.title, opts.subtitle)];
  if (opts.options.length) {
    body.push(emphasisContainer(opts.options.map((o, i) => selectRow(o, opts.verb, i > 0))));
  }
  if (opts.footer) body.push(text(opts.footer, { isSubtle: true, size: 'small', spacing: 'small', wrap: true }));
  return card(body);
}

export function buildPanelCard(opts: {
  emoji?: string;
  title: string;
  rows: Array<{ label: string; value: string }>;
  url?: string;
}): Record<string, unknown> {
  const body: CardElement[] = [
    ...headerBlock(opts.emoji ?? 'ℹ️', opts.title),
    emphasisContainer([{ type: 'FactSet', facts: opts.rows.map((r) => ({ title: r.label, value: r.value })) }]),
  ];
  const actions = opts.url ? [openUrlAction('Open in Kortix', opts.url)] : undefined;
  return card(body, actions);
}

export function buildQuestionCard(
  questions: Array<{ question: string; options?: Array<{ label: string }> }>,
): Record<string, unknown> {
  const body: CardElement[] = [...headerBlock('💬', 'A quick question')];
  for (const q of questions) body.push(text(q.question, { weight: 'bolder', wrap: true, spacing: 'small' }));
  const seen = new Set<string>();
  const actions: CardElement[] = [];
  for (const o of questions.flatMap((q) => q.options ?? [])) {
    if (!o.label || seen.has(o.label)) continue;
    seen.add(o.label);
    actions.push(executeAction(o.label, 'teams_answer', { answer: o.label }));
    if (actions.length >= 6) break;
  }
  body.push(text('Tap an option, or just reply in the chat.', { isSubtle: true, size: 'small', spacing: 'medium' }));
  return card(body, actions.length ? actions : undefined);
}

export function buildReviewCard(opts: {
  reviewItemId: string;
  title: string;
  summary: string;
  risk: string;
  viewUrl?: string;
}): Record<string, unknown> {
  const riskColor = opts.risk === 'high' ? 'attention' : opts.risk === 'medium' ? 'warning' : 'good';
  const body: CardElement[] = [...headerBlock('📝', opts.title, opts.summary)];
  if (opts.risk && opts.risk !== 'none') {
    body.push(
      emphasisContainer([
        text(`Risk · ${opts.risk}`, { size: 'small', weight: 'bolder', color: riskColor, spacing: 'none' }),
      ]),
    );
  }
  const actions: CardElement[] = [
    { type: 'Action.Execute', title: 'Approve', verb: 'teams_review', data: { verb: 'teams_review', reviewItemId: opts.reviewItemId, verdict: 'approve' }, style: 'positive' },
    executeAction('Request changes', 'teams_review', { reviewItemId: opts.reviewItemId, verdict: 'changes' }),
    { type: 'Action.Execute', title: 'Deny', verb: 'teams_review', data: { verb: 'teams_review', reviewItemId: opts.reviewItemId, verdict: 'reject' }, style: 'destructive' },
  ];
  if (opts.viewUrl) actions.push(openUrlAction('View in Kortix', opts.viewUrl));
  return card(body, actions);
}

export function buildWelcomeCard(opts: { projectUrl?: string }): Record<string, unknown> {
  const body = headerBlock(
    '👋',
    'Kortix is connected here',
    '@-mention me with a task and an agent gets on it — replying right here with live progress. Type `/help` to see what I can do.',
  );
  const actions = opts.projectUrl ? [openUrlAction('Open in Kortix', opts.projectUrl)] : undefined;
  return card(body, actions);
}

export function buildHelpCard(commands: Array<{ cmd: string; desc: string }>): Record<string, unknown> {
  const rows: CardElement[] = commands.map((c, i) => ({
    type: 'ColumnSet',
    separator: i > 0,
    spacing: 'small',
    columns: [
      { type: 'Column', width: '90px', items: [text(c.cmd, { weight: 'bolder', spacing: 'none', color: 'accent' })] },
      { type: 'Column', width: 'stretch', items: [text(c.desc, { isSubtle: true, size: 'small', spacing: 'none', wrap: true })] },
    ],
  }));
  return card([
    ...headerBlock('⚡', 'Kortix commands', 'Run a command, or just @-mention me with a task.'),
    emphasisContainer(rows),
  ]);
}
