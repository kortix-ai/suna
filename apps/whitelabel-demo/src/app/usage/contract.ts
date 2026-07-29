/**
 * The wire contract between `/api/usage` and the Usage view, plus the pure
 * classifiers that turn a raw upstream reply into the one sentence a wrapper
 * author actually needs.
 *
 * These live apart from both the route and the components because the whole
 * point of the caps and idempotency probes is that the VERDICT is exact —
 * `per_end_user_spend_limit` is a different fact from `per_origin_session_limit`
 * and both are different from "something went wrong". Keeping the mapping pure
 * means a test can pin it without booting a browser.
 */

export interface UsageSession {
  session_id: string;
  llm_cost?: number;
  compute_cost?: number;
  tokens?: number;
  compute_seconds?: number;
  total_cost?: number;
  billed_cost?: number;
}

export interface UsageProject {
  projectId: string;
  sessions: UsageSession[];
  error?: string;
}

export interface EndUserBill {
  endUserRef: string;
  rawCost: number;
  billedCost: number;
  sessions: number;
}

/** One `GET /v1/usage` answer, marked up. */
export interface UsageMoney {
  rawCost: number;
  billedCost: number;
  sessions: number;
}

export interface UsageResponse {
  markup: number;
  /**
   * The `end_user_ref` upstream sees for this browser — the signed-in email,
   * stamped server-side. The client cannot influence it; it is echoed here only
   * so the view can name the label it is showing.
   */
  endUserRef: string;
  /** Whether this signed-in user may read the ACCOUNT-wide rollups. */
  operator: boolean;
  /** What the grouped breakdown below actually covers. */
  scope: 'account' | 'self';

  /** Per-project gateway sums across the projects this user owns. */
  totals: { raw: number; billed: number };
  projects: UsageProject[];

  /** `GET /v1/usage?end_user_ref=<me>` — this end-user's own spend. */
  mine: UsageMoney | null;
  mineError: string | null;

  /** `GET /v1/usage?group_by=end_user_ref` — the per-end-user split. */
  by_end_user: EndUserBill[];
  groupedError: string | null;

  /** `GET /v1/usage` with no grouping and no narrowing. Operator-only. */
  accountTotal: UsageMoney | null;
  accountTotalError: string | null;

  /**
   * Account total MINUS everything the grouped breakdown attributed. This is
   * the gap the caveat is about: dashboard sessions and anything predating
   * `end_user_ref` carry a NULL ref, so upstream leaves them out of the grouping
   * while still counting them in the total. `null` when it cannot be computed
   * (no account total to subtract from) — which is NOT the same as zero.
   */
  unattributed_cost: number | null;
  /** The env var an operator sets to unlock the account-wide rollups. */
  operatorEnvVar: string;
}

// ── Probes ───────────────────────────────────────────────────────────────────

export type ProbeKind = 'caps' | 'idempotency';
export type IdempotencyVariant = 'replay' | 'conflict';

/** One session-create attempt, reported verbatim so nothing is smoothed over. */
export interface ProbeAttempt {
  label: string;
  status: number;
  /** The upstream `code` field, when it sent one. */
  code: string | null;
  /** The upstream `error` text, when it sent one. */
  message: string | null;
  sessionId: string | null;
  /** The exact `Idempotency-Key` header this attempt carried, if any. */
  idempotencyKey: string | null;
  /** The exact JSON body sent upstream, `end_user_ref` included. */
  sentBody: Record<string, unknown>;
}

export type ProbeVerdictKind =
  | 'created'
  | 'replayed'
  | 'not-idempotent'
  | 'conflict'
  | 'cap'
  | 'refused';

export interface ProbeVerdict {
  kind: ProbeVerdictKind;
  /** The upstream code this verdict is derived from — rendered, never hidden. */
  code: string | null;
  title: string;
  detail: string;
}

export interface ProbeResponse {
  probe: ProbeKind;
  endUserRef: string;
  attempts: ProbeAttempt[];
  verdict: ProbeVerdict;
}

/** The two opt-in per-end-user caps, plus the account-wide one they sit beside. */
export const CAP_CODES = [
  'per_origin_session_limit',
  'per_end_user_spend_limit',
  'concurrent_session_limit',
] as const;

export function isCapCode(code: string | null): boolean {
  return code !== null && (CAP_CODES as readonly string[]).includes(code);
}

export function isIdempotencyConflictCode(code: string | null): boolean {
  return code !== null && /^IDEMPOTENCY_.*(CONFLICT|DELETED)$/.test(code);
}

function capVerdict(attempt: ProbeAttempt): ProbeVerdict {
  // Each cap is somebody different's problem, so they get different words. The
  // code is carried through on purpose: a wrapper author reading this screen is
  // about to write a `switch` on exactly that string.
  switch (attempt.code) {
    case 'per_origin_session_limit':
      return {
        kind: 'cap',
        code: attempt.code,
        title: 'Concurrency cap fired',
        detail:
          attempt.message ??
          'This end-user is holding as many live sessions as the operator allows. Finishing one clears it.',
      };
    case 'per_end_user_spend_limit':
      return {
        kind: 'cap',
        code: attempt.code,
        title: 'Spend cap fired',
        detail:
          attempt.message ??
          'This end-user has spent their ceiling for the current rolling window.',
      };
    default:
      return {
        kind: 'cap',
        code: attempt.code,
        title: 'Account-wide capacity cap fired',
        detail:
          attempt.message ??
          'The whole account is at its concurrent-session limit — not this end-user specifically.',
      };
  }
}

function refusedVerdict(attempt: ProbeAttempt): ProbeVerdict {
  return {
    kind: 'refused',
    code: attempt.code,
    title: `Upstream refused with ${attempt.status}`,
    detail:
      attempt.message ??
      'No cap and no idempotency conflict — upstream declined this create for another reason.',
  };
}

/**
 * One create, one verdict. A 2xx here is the honest answer "no cap fired",
 * NOT "there is no cap" — both caps are off unless the operator turned them on.
 */
export function classifyCapProbe(attempt: ProbeAttempt): ProbeVerdict {
  if (attempt.status === 429 || isCapCode(attempt.code)) return capVerdict(attempt);
  if (attempt.status >= 200 && attempt.status < 300) {
    return {
      kind: 'created',
      code: null,
      title: 'No cap fired',
      detail:
        'Upstream created the session. Both per-end-user caps are off by default — this is what an unconfigured deployment looks like, not proof that a cap exists.',
    };
  }
  return refusedVerdict(attempt);
}

/**
 * Two creates under ONE key. The distinction this exists to make visible: a
 * replay returns the SAME `session_id` (no second sandbox, no second charge),
 * whereas a replay whose body changed is refused 409 rather than quietly handing
 * back a session that was built from different inputs.
 */
export function classifyIdempotencyProbe(
  first: ProbeAttempt,
  second: ProbeAttempt,
): ProbeVerdict {
  const firstOk = first.status >= 200 && first.status < 300;
  if (!firstOk) {
    // Nothing to replay against — say so instead of blaming the second call.
    return {
      ...(first.status === 429 || isCapCode(first.code)
        ? capVerdict(first)
        : refusedVerdict(first)),
      detail: `The FIRST create never succeeded, so there is no replay to show. ${
        first.message ?? ''
      }`.trim(),
    };
  }

  if (isIdempotencyConflictCode(second.code)) {
    return {
      kind: 'conflict',
      code: second.code,
      title: 'Same key, different body — 409',
      detail:
        second.message ??
        'Upstream refused rather than return the first session, because the second body would have produced a different one.',
    };
  }
  if (second.status === 429 || isCapCode(second.code)) return capVerdict(second);

  const secondOk = second.status >= 200 && second.status < 300;
  if (secondOk && second.sessionId !== null && second.sessionId === first.sessionId) {
    return {
      kind: 'replayed',
      code: null,
      title: 'Same session came back',
      detail:
        'The second create returned the first session id. One sandbox, one charge — this is what makes a blind retry safe.',
    };
  }
  if (secondOk) {
    // A different id here means the key did nothing, which is the failure mode
    // the control exists to make impossible to miss.
    return {
      kind: 'not-idempotent',
      code: null,
      title: 'A SECOND session was created',
      detail:
        'The key was not honoured — the retry provisioned a new session. Do not build at-most-once semantics on this deployment until that is fixed.',
    };
  }
  return refusedVerdict(second);
}
