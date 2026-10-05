/**
 * A synthetic Kortix Capture dataset with ground truth, for measuring Capture
 * Intelligence (episodes, step traces, workflow mining). Deterministic from a
 * seed. Synthetic only: invented apps, people, customers and values.
 *
 * Seven recurring workflows, each with known canonical steps and 1–2 more
 * variants, run by six people over N workdays; between them noise (reading
 * news, chat, mail triage) and interruptions (a chat in the middle of a run,
 * an abandoned run). Every run becomes screen frames (app, window title with
 * the entity, on-screen text with literal values) and input actions (clicks,
 * typing literal values, hotkeys, screenshots), as the engine records them.
 *
 * `truth` names, per device, the time span of every run with its workflow and
 * variant: the evaluator compares the pipeline's episodes and workflows to it.
 */

export interface StepDef {
  verb: string;
  app: string;
  object: string;
  /** Window title; `{x}` fills from the run's values. */
  title: string;
  /** On-screen text. */
  text: string;
  /** Text the person types (a literal value). */
  type?: string;
  seconds: [number, number];
}

export interface WorkflowDef {
  id: string;
  name: string;
  steps: StepDef[];
  /** Variant B, C: the canonical steps up to `at`, then their own `then` steps (and back to canonical `resume`). */
  variants: { key: string; name: string; share: number; at: number; then: StepDef[]; resume?: number }[];
}

const s = (verb: string, app: string, object: string, title: string, text: string, seconds: [number, number], type?: string): StepDef => ({ verb, app, object, title, text, seconds, type });

export const WORKFLOWS: WorkflowDef[] = [
  {
    id: 'refund',
    name: 'Refund a damaged-order claim',
    steps: [
      s('Open', 'Helpdesk', 'ticket in the Damaged in transit view', 'Ticket #{ticket} — Helpdesk', 'Damaged in transit ticket {ticket} from {email} order {order}', [20, 45]),
      s('Copy', 'Helpdesk', 'order number from the ticket', 'Ticket #{ticket} — Helpdesk', 'Order number {order} customer {email}', [8, 15]),
      s('Search', 'ERP', 'orders by number', 'Orders — ERP', 'Orders search results order {order}', [15, 30], '{order}'),
      s('Read', 'ERP', 'delivery status and date', 'Order {order} — ERP', 'Shipments delivered on {date} total {total}', [15, 40]),
      s('Open', 'Helpdesk', 'photo attachment and confirm the damage', 'Attachment — Helpdesk', 'Photo of damaged box order {order}', [15, 35]),
      s('Create', 'ERP', 'refund with reason Damaged', 'New refund — ERP', 'Refund order {order} amount {total} reason Damaged', [30, 60], '{total}'),
      s('Send', 'Mail', 'reply Refund issued to the customer', 'Reply to {email} — Mail', 'Your refund of {total} for order {order} is issued', [20, 45], 'Refund issued'),
      s('Set', 'Helpdesk', 'ticket to Solved with tag refund_issued', 'Ticket #{ticket} — Helpdesk', 'Status Solved tag refund_issued', [8, 15]),
    ],
    variants: [
      {
        key: 'B', name: 'Outside the 30-day window', share: 0.2, at: 4,
        then: [
          s('Send', 'Mail', 'reply Outside return window', 'Reply to {email} — Mail', 'Your order {order} is outside the 30-day return window', [20, 40], 'Outside return window'),
          s('Set', 'Helpdesk', 'ticket to Solved with tag policy_denied', 'Ticket #{ticket} — Helpdesk', 'Status Solved tag policy_denied', [8, 15]),
        ],
      },
      {
        key: 'C', name: 'One item damaged', share: 0.15, at: 5, resume: 6,
        then: [
          s('Select', 'ERP', 'the damaged line item', 'Order {order} items — ERP', 'Line item {sku} price {item}', [15, 30]),
          s('Create', 'ERP', 'refund of the line item total', 'New refund — ERP', 'Refund order {order} amount {item} reason Damaged item', [25, 50], '{item}'),
        ],
      },
    ],
  },
  {
    id: 'invoice',
    name: 'Reconcile a vendor invoice to its PO',
    steps: [
      s('Open', 'Mail', 'invoice email from the vendor', 'Invoice {invoice} — Mail', 'Invoice {invoice} from {vendor} amount {total}', [15, 30]),
      s('Download', 'Mail', 'invoice PDF', 'Invoice {invoice} — Mail', 'Attachment invoice-{invoice}.pdf', [5, 12]),
      s('Search', 'ERP', 'purchase orders by number', 'Purchase orders — ERP', 'PO search {po} vendor {vendor}', [15, 30], '{po}'),
      s('Read', 'ERP', 'PO amount and received quantity', 'PO {po} — ERP', 'PO {po} amount {total} received in full', [20, 40]),
      s('Update', 'Sheets', 'reconciliation row with invoice and PO', 'AP reconciliation — Sheets', 'Row invoice {invoice} PO {po} amount {total} matched', [30, 60], '{invoice}'),
      s('Approve', 'ERP', 'invoice for payment', 'Invoice approval — ERP', 'Approve invoice {invoice} for payment {total}', [10, 20]),
    ],
    variants: [
      {
        key: 'B', name: 'Amount mismatch', share: 0.25, at: 4,
        then: [
          s('Update', 'Sheets', 'reconciliation row as mismatch', 'AP reconciliation — Sheets', 'Row invoice {invoice} PO {po} mismatch {total}', [20, 40], 'mismatch'),
          s('Send', 'Mail', 'query to the vendor about the amount', 'Reply to {vendor} — Mail', 'Invoice {invoice} does not match PO {po}', [30, 60], 'Amount does not match the PO'),
        ],
      },
    ],
  },
  {
    id: 'address',
    name: 'Update a shipping address',
    steps: [
      s('Open', 'Helpdesk', 'address change ticket', 'Ticket #{ticket} — Helpdesk', 'Please change my shipping address order {order} new address {street}', [15, 30]),
      s('Search', 'ERP', 'orders by number', 'Orders — ERP', 'Orders search results order {order}', [10, 25], '{order}'),
      s('Update', 'ERP', 'shipping address on the order', 'Order {order} shipping — ERP', 'Shipping address {street}', [25, 50], '{street}'),
      s('Send', 'Mail', 'confirmation to the customer', 'Reply to {email} — Mail', 'Your new address for order {order} is saved', [15, 30], 'Address updated'),
      s('Set', 'Helpdesk', 'ticket to Solved', 'Ticket #{ticket} — Helpdesk', 'Status Solved tag address_updated', [5, 12]),
    ],
    variants: [
      {
        key: 'B', name: 'Already shipped', share: 0.2, at: 2,
        then: [
          s('Open', 'Browser', 'carrier redirect page', 'Carrier redirect — Browser', 'Redirect shipment tracking {tracking} to {street}', [40, 80], '{tracking}'),
          s('Send', 'Mail', 'redirect confirmation to the customer', 'Reply to {email} — Mail', 'Your parcel {tracking} is redirected', [15, 30], 'Parcel redirected'),
          s('Set', 'Helpdesk', 'ticket to Solved', 'Ticket #{ticket} — Helpdesk', 'Status Solved tag carrier_redirect', [5, 12]),
        ],
      },
    ],
  },
  {
    id: 'stock',
    name: 'Weekly stock-level report',
    steps: [
      s('Export', 'ERP', 'stock levels report as CSV', 'Reports stock levels — ERP', 'Stock levels export week {week}', [20, 40]),
      s('Open', 'Sheets', 'weekly stock report sheet', 'Stock report {week} — Sheets', 'Stock report week {week} warehouse', [10, 20]),
      s('Paste', 'Sheets', 'stock levels into the data tab', 'Stock report {week} — Sheets', 'Data tab {rows} rows pasted', [20, 40]),
      s('Update', 'Sheets', 'low-stock chart', 'Stock report {week} — Sheets', 'Chart low stock items {sku}', [30, 60]),
      s('Send', 'Chat', 'report link to the ops channel', 'ops — Chat', 'Stock report week {week} is ready', [10, 20], 'Stock report week {week} is ready'),
    ],
    variants: [
      {
        key: 'B', name: 'Reorder low stock', share: 0.3, at: 4, resume: 4,
        then: [s('Create', 'ERP', 'purchase order for low-stock items', 'New purchase order — ERP', 'Reorder {sku} quantity {rows}', [40, 80], '{sku}')],
      },
    ],
  },
  {
    id: 'expense',
    name: 'Approve an expense report',
    steps: [
      s('Open', 'Mail', 'expense approval request', 'Expense report {expense} — Mail', 'Expense report {expense} from {person} total {total}', [10, 20]),
      s('Open', 'Billing', 'expense report', 'Expense {expense} — Billing', 'Expense {expense} lines total {total}', [15, 30]),
      s('Review', 'Billing', 'receipts for each line', 'Expense {expense} receipts — Billing', 'Receipt hotel {total} receipt taxi', [30, 60]),
      s('Approve', 'Billing', 'expense report', 'Expense {expense} — Billing', 'Approved expense {expense}', [5, 10]),
    ],
    variants: [
      {
        key: 'B', name: 'Missing receipt', share: 0.25, at: 3,
        then: [s('Reject', 'Billing', 'expense report with a note', 'Expense {expense} — Billing', 'Rejected expense {expense} missing receipt', [15, 30], 'Missing receipt for line 2')],
      },
    ],
  },
  {
    id: 'callback',
    name: 'Book a customer callback',
    steps: [
      s('Open', 'Helpdesk', 'callback request ticket', 'Ticket #{ticket} — Helpdesk', 'Callback requested by {email} phone', [10, 25]),
      s('Open', 'Calendar', 'team calendar', 'Support team — Calendar', 'Free slots {slot}', [10, 25]),
      s('Create', 'Calendar', 'callback event in a free slot', 'New event — Calendar', 'Callback {email} at {slot}', [20, 40], 'Callback {ticket}'),
      s('Send', 'Mail', 'callback time to the customer', 'Reply to {email} — Mail', 'We will call you at {slot}', [15, 30], 'Callback booked'),
    ],
    variants: [
      {
        key: 'B', name: 'No free slot', share: 0.2, at: 2,
        then: [s('Send', 'Mail', 'three proposed times to the customer', 'Reply to {email} — Mail', 'Which of these times suits you {slot}', [20, 40], 'Proposed times')],
      },
    ],
  },
  {
    id: 'escalate',
    name: 'Escalate a late shipment to the carrier',
    steps: [
      s('Open', 'Helpdesk', 'late shipment ticket', 'Ticket #{ticket} — Helpdesk', 'Where is my order {order} late', [10, 25]),
      s('Search', 'ERP', 'orders by number', 'Orders — ERP', 'Orders search results order {order}', [10, 20], '{order}'),
      s('Open', 'Browser', 'carrier tracking page', 'Tracking {tracking} — Browser', 'Tracking {tracking} in transit delayed', [20, 40], '{tracking}'),
      s('Send', 'Mail', 'escalation to the carrier', 'New message to carrier — Mail', 'Escalation shipment {tracking} order {order} late', [30, 60], 'Please escalate {tracking}'),
      s('Update', 'Helpdesk', 'ticket with the escalation note', 'Ticket #{ticket} — Helpdesk', 'Internal note escalated {tracking}', [10, 20], 'Escalated to carrier'),
    ],
    variants: [],
  },
];

export const PEOPLE = [
  { id: 'p1', name: 'Support A', workflows: { refund: 4, address: 2, callback: 2, escalate: 1 } },
  { id: 'p2', name: 'Support B', workflows: { refund: 3, address: 3, callback: 2, escalate: 2 } },
  { id: 'p3', name: 'Support C', workflows: { refund: 3, callback: 3, escalate: 2 } },
  { id: 'p4', name: 'Finance A', workflows: { invoice: 4, expense: 3 } },
  { id: 'p5', name: 'Finance B', workflows: { invoice: 3, expense: 2 } },
  { id: 'p6', name: 'Operations', workflows: { stock: 1, invoice: 2, escalate: 1 } },
] as const;

const NOISE: StepDef[][] = [
  [s('Read', 'Browser', 'news', 'Industry news — Browser', 'Markets today weather forecast', [60, 240])],
  [s('Read', 'Chat', 'team channel', 'general — Chat', 'Lunch at noon anyone', [30, 120]), s('Send', 'Chat', 'a message', 'general — Chat', 'sure', [10, 30], 'sounds good')],
  [s('Read', 'Mail', 'inbox newsletters', 'Inbox — Mail', 'Newsletter weekly digest', [40, 150])],
  [s('Open', 'Docs', 'team handbook', 'Handbook — Docs', 'Handbook holidays policy', [60, 200])],
];

/** mulberry32: a small deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Activity {
  /** Seconds since the epoch, as ms. */
  ts: number;
  app: string;
  title: string;
  text: string;
  /** An action at this moment, or none (a screen frame only). */
  action?: { kind: 'click' | 'typewrite' | 'hotkey' | 'screenshot'; text?: string };
}

export interface TruthRun {
  person: string;
  workflow: string;
  variant: string;
  start: number;
  end: number;
  /** The run was interrupted (a chat in the middle) or abandoned. */
  interrupted: boolean;
  abandoned: boolean;
  /** The steps actually done, as `verb@app`. */
  path: string[];
}

export interface PersonDays {
  person: string;
  activity: Activity[];
}

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? k);
}

function runValues(r: () => number, n: number): Record<string, string> {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const first = pick(['alex', 'sam', 'robin', 'kim', 'jo', 'lee', 'max', 'ari']);
  return {
    ticket: String(40000 + Math.floor(r() * 9999)),
    order: `SO-${100000 + Math.floor(r() * 899999)}`,
    email: `${first}.${n}@customer.example`,
    date: `2026-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`,
    total: `${20 + Math.floor(r() * 400)}.${Math.floor(r() * 90) + 10} EUR`,
    item: `${5 + Math.floor(r() * 60)}.00 EUR`,
    sku: `SKU-${1000 + Math.floor(r() * 8999)}`,
    invoice: `INV-${20000 + Math.floor(r() * 9999)}`,
    po: `PO-${7000 + Math.floor(r() * 2999)}`,
    vendor: pick(['Northwind Parts', 'Acme Paper', 'Blue Freight', 'Delta Boxes']),
    street: `${1 + Math.floor(r() * 200)} ${pick(['Main', 'Oak', 'Mill', 'Harbor'])} Street`,
    tracking: `TRK${100000000 + Math.floor(r() * 899999999)}`,
    week: String(30 + Math.floor(r() * 20)),
    rows: String(80 + Math.floor(r() * 400)),
    expense: `EXP-${300 + Math.floor(r() * 699)}`,
    person: pick(['a colleague', 'the sales lead', 'a field engineer']),
    slot: `${9 + Math.floor(r() * 8)}:${pick(['00', '30'])}`,
  };
}

/** Steps of one run: the canonical path or a variant's. */
function pathOf(w: WorkflowDef, variant: string): StepDef[] {
  const v = w.variants.find((x) => x.key === variant);
  if (!v) return w.steps;
  return [...w.steps.slice(0, v.at), ...v.then, ...(v.resume !== undefined ? w.steps.slice(v.resume) : [])];
}

/**
 * Generate `days` workdays ending the day before `endDay` (UTC midnight, ms).
 * Each person works 09:00–17:00 UTC; runs per day follow PEOPLE (± noise).
 */
export function generate(opts: { seed: number; days: number; endDay: number }) {
  const r = rng(opts.seed);
  const persons: PersonDays[] = [];
  const truth: TruthRun[] = [];
  let n = 0;
  for (const person of PEOPLE) {
    const activity: Activity[] = [];
    for (let d = opts.days; d >= 1; d--) {
      const day = opts.endDay - d * 86_400_000;
      const weekday = new Date(day).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      let t = day + 9 * 3600_000 + Math.floor(r() * 30 * 60_000);
      const end = day + 17 * 3600_000;
      // Today's runs in random order, with noise blocks between them.
      const todo: string[] = [];
      for (const [id, perDay] of Object.entries(person.workflows)) {
        const count = Math.max(0, Math.round(perDay + (r() - 0.5) * 2));
        for (let i = 0; i < count; i++) todo.push(id);
      }
      todo.sort(() => r() - 0.5);
      for (const id of todo) {
        if (t > end) break;
        if (r() < 0.6) {
          for (const step of NOISE[Math.floor(r() * NOISE.length)]!) t = emit(activity, step, {}, t, r);
          t += Math.floor(r() * 4 * 60_000);
        }
        const w = WORKFLOWS.find((x) => x.id === id)!;
        let roll = r();
        let variant = 'A';
        for (const v of w.variants) {
          if (roll < v.share) {
            variant = v.key;
            break;
          }
          roll -= v.share;
        }
        const values = runValues(r, ++n);
        const steps = pathOf(w, variant);
        const abandoned = r() < 0.05;
        const interruptAt = r() < 0.15 ? 1 + Math.floor(r() * (steps.length - 2)) : -1;
        const start = t;
        const done: string[] = [];
        const last = abandoned ? Math.max(2, Math.floor(steps.length / 2)) : steps.length;
        for (let i = 0; i < last; i++) {
          if (i === interruptAt) {
            // A chat in the middle of the run, then back to it.
            t = emit(activity, s('Read', 'Chat', 'a direct message', 'Direct message — Chat', 'quick question about the meeting', [40, 90]), {}, t, r);
            t = emit(activity, s('Send', 'Chat', 'a reply', 'Direct message — Chat', 'answered', [10, 25], 'will check after this'), {}, t, r);
          }
          t = emit(activity, steps[i]!, values, t, r);
          done.push(`${steps[i]!.verb}@${steps[i]!.app}`);
        }
        truth.push({ person: person.id, workflow: id, variant, start, end: t, interrupted: interruptAt >= 0, abandoned, path: done });
        // A pause between tasks: 1–12 minutes.
        t += 60_000 + Math.floor(r() * 11 * 60_000);
      }
    }
    persons.push({ person: person.id, activity });
  }
  return { persons, truth };
}

/** One step: a frame every ~10 s while it lasts, a click at its start, typing, and a screenshot on some steps. */
function emit(out: Activity[], step: StepDef, values: Record<string, string>, t: number, r: () => number): number {
  const seconds = step.seconds[0] + Math.floor(r() * (step.seconds[1] - step.seconds[0]));
  const title = fill(step.title, values);
  // On-screen text carries the values, never the step's verb or object: the pipeline must infer those.
  const text = fill(step.text, values);
  // The click target is the control's label, like the engine's accessibility target: the verb's button.
  out.push({ ts: t, app: step.app, title, text, action: { kind: 'click', text: step.verb } });
  if (r() < 0.35) out.push({ ts: t + 1_000, app: step.app, title, text, action: { kind: 'screenshot' } });
  for (let at = 0; at < seconds; at += 10) out.push({ ts: t + at * 1000 + 500, app: step.app, title, text });
  if (step.type) out.push({ ts: t + Math.floor(seconds * 600), app: step.app, title, text, action: { kind: 'typewrite', text: fill(step.type, values) } });
  if (step.verb === 'Update' || step.verb === 'Create') out.push({ ts: t + seconds * 1000 - 500, app: step.app, title, text, action: { kind: 'hotkey', text: 'command+s' } });
  return t + seconds * 1000;
}
