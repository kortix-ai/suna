import { randomUUID } from 'node:crypto';
import type { PermissionRequest } from '@opencode-ai/sdk/v2';

import {
  type PermissionConfig,
  type PermissionRule,
  compilePermissionRules,
  evaluatePermission,
  permissionNameForTool,
  wildcardMatch,
} from './permission-policy.ts';

export type PermissionReply = 'once' | 'always' | 'reject';

export type PermissionEvent =
  | { type: 'permission.asked'; properties: PermissionRequest }
  | {
      type: 'permission.replied';
      properties: { sessionID: string; requestID: string; reply: PermissionReply };
    };

export interface PermissionAuthorization {
  permission: string;
  patterns: string[];
  always: string[];
  metadata: Record<string, unknown>;
  tool?: PermissionRequest['tool'];
  signal?: AbortSignal;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  replying?: { reply: PermissionReply; done: Promise<boolean> };
}

export interface PermissionApproval {
  requestId: string;
  permission: string;
  patterns: string[];
}

export class PermissionApprovalUnavailableError extends Error {
  constructor(cause: unknown) {
    super('permission approval could not be saved; retry the reply', { cause });
    this.name = 'PermissionApprovalUnavailableError';
  }
}

export interface PermissionBrokerOptions {
  sessionId: string;
  permission?: PermissionConfig;
  publish: (event: PermissionEvent) => void;
  createId?: () => string;
  approved?: readonly PermissionApproval[];
  saveApproval?: (approval: PermissionApproval) => Promise<void>;
}

export class PermissionDeniedError extends Error {
  constructor(
    public readonly permission: string,
    public readonly patterns: readonly string[],
  ) {
    super(`permission denied: ${permission} (${patterns.join(', ')})`);
    this.name = 'PermissionDeniedError';
  }
}

export class PermissionRejectedError extends Error {
  constructor(requestId: string, message?: string) {
    super(message?.trim() || `permission ${requestId} was rejected by the user`);
    this.name = 'PermissionRejectedError';
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('permission request was aborted');
}

function cloneRequest(request: PermissionRequest): PermissionRequest {
  return structuredClone(request);
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly approved: PermissionRule[] = [];
  private readonly rules: PermissionRule[];
  private sessionRules: PermissionRule[] = [];
  private readonly createId: () => string;

  constructor(private readonly options: PermissionBrokerOptions) {
    this.rules = compilePermissionRules(options.permission);
    this.createId = options.createId ?? (() => `per_${randomUUID().replaceAll('-', '')}`);
    for (const approval of options.approved ?? []) this.addApproval(approval);
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((item) => cloneRequest(item.request));
  }

  setToolControls(controls: Record<string, boolean>): void {
    this.sessionRules = Object.entries(controls).map(([permission, enabled]) => ({
      permission,
      pattern: '*',
      action: enabled ? 'allow' : 'deny',
    }));
  }

  toolEnabled(toolName: string): boolean {
    const permission = permissionNameForTool(toolName);
    const rule = [...this.rules, ...this.sessionRules].findLast(
      (candidate) => wildcardMatch(permission, candidate.permission),
    );
    return rule?.pattern !== '*' || rule.action !== 'deny';
  }

  authorize(input: PermissionAuthorization): Promise<void> {
    if (input.patterns.length === 0) {
      return Promise.reject(new TypeError('permission patterns must contain at least one value'));
    }
    if (input.signal?.aborted) return Promise.reject(abortError(input.signal));
    const rules = [...this.rules, ...this.sessionRules, ...this.approved];
    let needsAsk = false;
    for (const pattern of input.patterns) {
      const action = evaluatePermission(input.permission, pattern, rules).action;
      if (action === 'deny') {
        return Promise.reject(new PermissionDeniedError(input.permission, input.patterns));
      }
      if (action === 'ask') needsAsk = true;
    }
    if (!needsAsk) return Promise.resolve();

    const id = this.createId();
    if (!id || this.pending.has(id)) {
      return Promise.reject(new Error(`permission id ${id || '<empty>'} is not unique`));
    }
    const request: PermissionRequest = {
      id,
      sessionID: this.options.sessionId,
      permission: input.permission,
      patterns: structuredClone(input.patterns),
      metadata: structuredClone(input.metadata),
      always: structuredClone(input.always),
      ...(input.tool ? { tool: structuredClone(input.tool) } : {}),
    };

    return new Promise<void>((resolve, reject) => {
      const pending: PendingPermission = { request, resolve, reject, signal: input.signal };
      const signal = input.signal;
      if (signal) {
        pending.onAbort = () => this.cancelForAbort(id, abortError(signal));
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        this.options.publish({ type: 'permission.asked', properties: cloneRequest(request) });
      } catch (error) {
        this.take(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async reply(requestId: string, reply: PermissionReply, message?: string): Promise<boolean> {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (pending.replying) return pending.replying.reply === reply ? pending.replying.done : false;
    const done = this.applyReply(pending, reply, message);
    pending.replying = { reply, done };
    try {
      return await done;
    } finally {
      if (pending.replying?.done === done) pending.replying = undefined;
    }
  }

  private async applyReply(
    pending: PendingPermission,
    reply: PermissionReply,
    message?: string,
  ): Promise<boolean> {
    const requestId = pending.request.id;
    if (reply === 'always') {
      const approval = {
        requestId,
        permission: pending.request.permission,
        patterns: [...pending.request.always],
      };
      try {
        await this.options.saveApproval?.(approval);
      } catch (cause) {
        throw new PermissionApprovalUnavailableError(cause);
      }
      this.addApproval(approval);
    }
    if (this.take(requestId) !== pending) return false;
    this.publishReply(pending.request, reply);

    if (reply === 'reject') {
      pending.reject(new PermissionRejectedError(requestId, message));
      this.rejectRemaining();
      return true;
    }

    pending.resolve();
    if (reply === 'once') return true;
    this.resolveApprovedPending();
    return true;
  }

  private addApproval(approval: PermissionApproval): void {
    for (const pattern of approval.patterns) {
      this.approved.push({
        permission: approval.permission,
        pattern,
        action: 'allow',
      });
    }
  }

  private cancelForAbort(requestId: string, error: Error): void {
    const pending = this.take(requestId);
    if (!pending) return;
    this.publishReply(pending.request, 'reject');
    pending.reject(error);
  }

  private publishReply(request: PermissionRequest, reply: PermissionReply): void {
    this.options.publish({
      type: 'permission.replied',
      properties: {
        sessionID: request.sessionID,
        requestID: request.id,
        reply,
      },
    });
  }

  private rejectRemaining(): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.take(id);
      if (!pending) continue;
      this.publishReply(pending.request, 'reject');
      pending.reject(new PermissionRejectedError(id));
    }
  }

  private resolveApprovedPending(): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      const approved = pending.request.patterns.every(
        (pattern) =>
          evaluatePermission(pending.request.permission, pattern, this.approved).action === 'allow',
      );
      if (!approved) continue;
      this.take(id);
      this.publishReply(pending.request, 'always');
      pending.resolve();
    }
  }

  private take(requestId: string): PendingPermission | null {
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    this.pending.delete(requestId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    return pending;
  }
}
