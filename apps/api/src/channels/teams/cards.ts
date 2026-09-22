import type { StreamTaskChunk } from '../slack-api';
import { markdownToCardElements } from './markdown';

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
  if (step.sources && step.sources.length > 0) {
    // Citations as a footer of links — the Teams twin of the Slack step
    // `sources`. TextBlock renders `[text](url)` markdown natively.
    const links = step.sources
      .slice(0, 8)
      .map((sc) => `[${sc.text || sc.url}](${sc.url})`)
      .join('  ·  ');
    out.push({ type: 'TextBlock', text: links, wrap: true, isSubtle: true, size: 'small', spacing: 'none' });
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

export const TEAMS_STOP_VERB = 'teams_stop';

/**
 * The live "working on it" card.
 *
 * `sessionId` adds the Stop button. Every other Kortix surface can end a run
 * the moment it goes wrong; in Teams the only lever was to wait out the
 * 30-minute GC, and a wedged turn swallowed every later message in the
 * conversation (dev 2026-09-19). The button carries the session id because the
 * invoke that comes back names no turn of its own.
 */
export function buildPlanCard(
  title: string,
  steps: StreamTaskChunk[],
  sessionId?: string,
): Record<string, unknown> {
  return card(
    planContainer(title, steps),
    sessionId ? [executeAction('Stop', TEAMS_STOP_VERB, { sessionId })] : undefined,
  );
}

export function buildFinalCard(opts: {
  title: string;
  steps: StreamTaskChunk[];
  body?: string;
  sessionUrl?: string;
}): Record<string, unknown> {
  const elements: CardElement[] = planContainer(opts.title, opts.steps);
  if (opts.body) {
    const [first, ...rest] = markdownToCardElements(opts.body);
    if (first) elements.push({ ...first, spacing: 'medium' }, ...rest);
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

export function buildAnswerCard(
  body: string,
  sessionUrl?: string,
  customCard?: Record<string, unknown>,
): Record<string, unknown> {
  // The agent handed us a full Adaptive Card (`teams send --card-file`): use
  // it verbatim, only appending the session link so the run stays openable.
  if (customCard && customCard.type === 'AdaptiveCard') {
    const out = { ...customCard };
    if (sessionUrl) {
      const bodyEls = Array.isArray(out.body) ? [...(out.body as CardElement[])] : [];
      bodyEls.push({
        type: 'TextBlock',
        text: `[Open session in Kortix ↗](${sessionUrl})`,
        wrap: true,
        isSubtle: true,
        size: 'small',
        spacing: 'medium',
      });
      out.body = bodyEls;
    }
    return out;
  }
  const elements: CardElement[] = markdownToCardElements(body);
  if (elements.length === 0) elements.push({ type: 'TextBlock', text: body, wrap: true });
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

/**
 * The agent picker, in both of its moods.
 *
 * `/agents` builds the neutral one: the conversation's current pick is marked
 * "✓ In use". A failed session start builds the recovery one by passing `lead`
 * — it leads with the failure, marks nothing as current (the conversation's own
 * pick is the dead agent it is replacing), and closes with what to do next.
 * Both carry the same `teams_set_agent` verb, so one tap fixes the conversation
 * either way and `interactivity.ts` needs no second handler.
 */
export function buildAgentPickerCard(opts: {
  agents: ReadonlyArray<{ name: string; description?: string | null }>;
  current: string | null;
  lead?: { title: string; subtitle: string };
}): Record<string, unknown> {
  const current = opts.lead ? null : opts.current;
  const options: SelectOption[] = [
    { label: 'Default', current: !opts.lead && !current, data: { agent: '' } },
    ...opts.agents.slice(0, 6).map((a) => ({
      label: a.name,
      hint: a.description ?? undefined,
      current: current === a.name,
      data: { agent: a.name },
    })),
  ];
  return buildSelectCard({
    emoji: opts.lead ? '⚠️' : '🤖',
    title: opts.lead?.title ?? 'Agent',
    subtitle: opts.lead?.subtitle ?? (current ? `Currently ${current}` : 'Currently the default agent'),
    verb: 'teams_set_agent',
    options,
    ...(opts.lead ? { footer: 'Pick one, then send your message again.' } : {}),
  });
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

export interface TeamsQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  /** Several answers allowed. */
  multiple?: boolean;
  /** An answer outside the listed options is allowed. */
  custom?: boolean;
}

const MAX_BUTTON_OPTIONS = 6;

/**
 * An `Input.*` id doubles as the label the agent reads back, because
 * `handleForm` relays `- <id>: <value>` and a `q1` would tell it nothing. Ids
 * cannot contain a comma — `fieldIds` travels comma-joined — so strip those
 * and keep it short enough to stay readable in the relayed message.
 */
function questionFieldId(question: string, index: number): string {
  const cleaned = question.replace(/[,\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `Question ${index + 1}`;
  return cleaned.length > 60 ? `${cleaned.slice(0, 59)}…` : cleaned;
}

/**
 * The card that asks. Two shapes, picked by what the question actually is.
 *
 * ONE question, a handful of options, one answer, no free text → a button per
 * option. It is one tap, and that is the common case.
 *
 * Anything else → a real form. The old card flattened EVERY option of EVERY
 * question into a single deduped button row: two questions offering "Yes"
 * showed one button, nothing said which question a button belonged to, and a
 * tap sent back a single bare label for what were several questions. It also
 * dropped `header`, `multiple`, `custom` and every option `description` on the
 * floor. A form answers all of them — one `Input.ChoiceSet` per question,
 * multi-select when asked, a text box when free-form answers are allowed — and
 * `handleForm` relays the answers back labelled with their questions.
 */
export function buildQuestionCard(questions: TeamsQuestion[]): Record<string, unknown> {
  const list = (questions ?? []).filter((q) => q?.question?.trim());
  if (list.length === 0) return buildNoticeCard('The agent asked a question, but it arrived empty.', '💬');

  const single = list.length === 1 ? list[0] : null;
  const options = single?.options?.filter((o) => o?.label?.trim()) ?? [];
  // `custom` deliberately does NOT force the form. The relay route defaults it
  // to true (`obj.custom === false ? false : true`, projects/routes/r4.ts), so
  // gating on it would turn every plain yes/no into a form with a Submit
  // button. In Teams the free-text path already exists and always has: the
  // card says "or just reply in the chat", and a reply arrives as the next
  // turn. The form's own "(other)" box is for when the user is in a form
  // anyway.
  const oneTap = single && options.length > 0 && options.length <= MAX_BUTTON_OPTIONS && !single.multiple;

  if (oneTap && single) {
    const body: CardElement[] = [...headerBlock('💬', single.header?.trim() || 'A quick question')];
    body.push(text(single.question, { weight: 'bolder', wrap: true, spacing: 'small' }));
    // An Action has no room for a subtitle, so a described option explains
    // itself above the buttons instead of losing the description entirely.
    for (const o of options) {
      if (o.description?.trim()) {
        body.push(text(`**${o.label}** — ${o.description.trim()}`, { isSubtle: true, size: 'small', spacing: 'small', wrap: true }));
      }
    }
    body.push(text('Tap an option, or just reply in the chat.', { isSubtle: true, size: 'small', spacing: 'medium' }));
    return card(
      body,
      // The question rides along with the answer. `Action.Execute` REPLACES
      // the card, so without it the conversation is left showing a bare
      // "Answer received: Yes" — no context for anyone reading the channel
      // later, and a bare label for the agent. Truncated because action data
      // travels on every tap.
      options.map((o) =>
        executeAction(o.label, 'teams_answer', {
          answer: o.label,
          question: single.question.slice(0, 200),
        }),
      ),
    );
  }

  const fields: TeamsFormField[] = [];
  for (const [i, q] of list.entries()) {
    const id = questionFieldId(q.question, i);
    const opts = q.options?.filter((o) => o?.label?.trim()) ?? [];
    if (opts.length > 0) {
      fields.push({
        id,
        label: q.question,
        type: q.multiple ? 'multichoice' : 'choice',
        // A description belongs on the choice itself, where the user reads it.
        choices: opts.map((o) => ({
          title: o.description?.trim() ? `${o.label} — ${o.description.trim()}` : o.label,
          value: o.label,
        })),
        placeholder: q.multiple ? 'Pick one or more' : 'Pick one',
      });
      // `custom` means the listed options are not exhaustive. Give that its own
      // box rather than pretending the list is closed.
      if (q.custom) {
        fields.push({ id: `${id} (other)`, label: 'Something else', type: 'text', placeholder: 'Your own answer' });
      }
    } else {
      fields.push({ id, label: q.question, type: 'textarea', placeholder: 'Your answer' });
    }
  }

  const form = buildFormCard({
    title: single?.header?.trim() || (list.length > 1 ? `${list.length} questions` : 'A quick question'),
    subtitle: 'Answer here, or just reply in the chat.',
    submitLabel: 'Send answers',
    fields,
  });
  // `buildFormCard` returns null only when nothing usable survived; the
  // questions still have to reach the user, so fall back to plain text.
  return form ?? buildNoticeCard(list.map((q) => q.question).join('\n\n'), '💬');
}

/** The id the review card's feedback box reports under. */
export const REVIEW_FEEDBACK_INPUT = 'reviewFeedback';

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
  // `Action.Execute` returns EVERY input on the card, whichever button was
  // pressed — so one optional box serves all three verdicts. Without it
  // `applyVerdict` was always called with `feedback: null` and the agent was
  // told to "ask what to change", asking the reviewer for something they
  // already knew when they clicked. The column has always existed
  // (review_items.feedback); nothing ever filled it.
  body.push(
    text('Feedback (optional)', { weight: 'bolder', size: 'small', spacing: 'medium' }),
    {
      type: 'Input.Text',
      id: REVIEW_FEEDBACK_INPUT,
      isMultiline: true,
      placeholder: 'What should change, or why — sent to the agent with your decision',
    },
  );
  const actions: CardElement[] = [
    { type: 'Action.Execute', title: 'Approve', verb: 'teams_review', data: { verb: 'teams_review', reviewItemId: opts.reviewItemId, verdict: 'approve' }, style: 'positive' },
    executeAction('Request changes', 'teams_review', { reviewItemId: opts.reviewItemId, verdict: 'changes' }),
    { type: 'Action.Execute', title: 'Deny', verb: 'teams_review', data: { verb: 'teams_review', reviewItemId: opts.reviewItemId, verdict: 'reject' }, style: 'destructive' },
  ];
  if (opts.viewUrl) actions.push(openUrlAction('View in Kortix', opts.viewUrl));
  return card(body, actions);
}

export function buildJoinRequestCard(opts: {
  requesterLabel: string;
  projectId: string;
  sessionId: string;
  conversationId: string;
  requesterUserId: string;
  requesterTeamsUserId: string;
}): Record<string, unknown> {
  const data = {
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    conversationId: opts.conversationId,
    requesterUserId: opts.requesterUserId,
    requesterTeamsUserId: opts.requesterTeamsUserId,
  };
  return card(
    headerBlock(
      '🔒',
      `${opts.requesterLabel} wants to join this Kortix session`,
      'This conversation is private until you approve them. Only the session owner can decide.',
    ),
    [
      { type: 'Action.Execute', title: 'Approve', verb: 'teams_thread_join', style: 'positive', data: { verb: 'teams_thread_join', decision: 'approved', ...data } },
      { type: 'Action.Execute', title: 'Deny', verb: 'teams_thread_join', style: 'destructive', data: { verb: 'teams_thread_join', decision: 'denied', ...data } },
    ],
  );
}

export function buildProjectPickerCard(
  projects: Array<{ projectId: string; name: string }>,
  pendingId: string | null,
): Record<string, unknown> {
  return card(
    headerBlock(
      '📁',
      'Which project should this conversation use?',
      "Several Kortix projects are connected to this team. Pick one — I'll remember it here and run your message.",
    ),
    projects.slice(0, 8).map((p) =>
      executeAction(p.name, 'teams_pick_project', { projectId: p.projectId, ...(pendingId ? { pendingId } : {}) }),
    ),
  );
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

// ─── Forms: real inputs, not a list of options in prose ─────────────────────
//
// Teams' only rich surface is the Adaptive Card, and a card can carry actual
// inputs — text boxes, dropdowns, toggles, dates — with one Submit. An
// `Action.Execute` returns every input's value to the bot in
// `activity.value.action.data`, keyed by the input's `id`, alongside the
// action's own data. `channels/teams/interactivity.ts` reads them back under
// the `teams_form` verb and feeds the answers into the session as the user's
// next message, so a form round-trips exactly like a typed reply.
//
// The card is built HERE rather than handed over as raw JSON by the agent so
// the submit verb, the field ids and the branding cannot drift, and so a
// malformed spec fails server-side instead of rendering a dead button.

export const TEAMS_FORM_VERB = 'teams_form';

/** One input on a form card. `type` maps onto the Adaptive Card input set. */
export interface TeamsFormField {
  id: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'date' | 'time' | 'choice' | 'multichoice' | 'toggle';
  placeholder?: string;
  value?: string;
  required?: boolean;
  /** For `choice` / `multichoice`. A bare string is both label and value. */
  choices?: Array<string | { title: string; value: string }>;
}

export interface TeamsFormSpec {
  title?: string;
  subtitle?: string;
  submitLabel?: string;
  fields: TeamsFormField[];
}

const MAX_FORM_FIELDS = 12;
const MAX_CHOICES = 24;

function choiceList(field: TeamsFormField): CardElement[] {
  return (field.choices ?? [])
    .slice(0, MAX_CHOICES)
    .map((c) => (typeof c === 'string' ? { title: c, value: c } : { title: c.title, value: c.value }))
    .filter((c) => !!c.title && !!c.value);
}

function formInput(field: TeamsFormField): CardElement | null {
  const id = field.id?.trim();
  // `fieldIds` travels as a comma-joined string on the submit action, so a
  // comma in an id would split one field into two on the way back.
  if (!id || id.includes(',')) return null;
  const common = { id, ...(field.required ? { isRequired: true, errorMessage: `${field.label} is required` } : {}) };
  switch (field.type ?? 'text') {
    case 'textarea':
      return { type: 'Input.Text', isMultiline: true, placeholder: field.placeholder, value: field.value, ...common };
    case 'number':
      return { type: 'Input.Number', placeholder: field.placeholder, value: field.value, ...common };
    case 'date':
      return { type: 'Input.Date', value: field.value, ...common };
    case 'time':
      return { type: 'Input.Time', value: field.value, ...common };
    case 'toggle':
      return { type: 'Input.Toggle', title: field.label, value: field.value ?? 'false', valueOn: 'true', valueOff: 'false', ...common };
    case 'choice':
    case 'multichoice': {
      const choices = choiceList(field);
      if (choices.length === 0) return null;
      return {
        type: 'Input.ChoiceSet',
        choices,
        ...(field.type === 'multichoice' ? { isMultiSelect: true, style: 'expanded' } : {}),
        placeholder: field.placeholder,
        value: field.value,
        ...common,
      };
    }
    default:
      return { type: 'Input.Text', placeholder: field.placeholder, value: field.value, ...common };
  }
}

/**
 * A card with real inputs and a Submit. Returns null when the spec carries no
 * usable field, so a caller never posts an empty form with a dead button.
 */
export function buildFormCard(spec: TeamsFormSpec): Record<string, unknown> | null {
  const fields = (spec.fields ?? []).slice(0, MAX_FORM_FIELDS);
  const body: CardElement[] = [...headerBlock('📝', spec.title?.trim() || 'A few details', spec.subtitle)];
  const ids: string[] = [];
  for (const field of fields) {
    const input = formInput(field);
    if (!input) continue;
    // A toggle renders its own label, so it does not get a second one.
    if ((field.type ?? 'text') !== 'toggle') {
      body.push(text(field.label, { weight: 'bolder', size: 'small', spacing: 'medium', wrap: true }));
    }
    body.push(input);
    ids.push(field.id.trim());
  }
  if (ids.length === 0) return null;
  return card(body, [
    executeAction(spec.submitLabel?.trim() || 'Submit', TEAMS_FORM_VERB, { fieldIds: ids.join(',') }),
  ]);
}
