/**
 * The two blocking interactions a turn can raise: a permission request before
 * a tool runs, and a question the agent asks the user. Both are Kortix types
 * (`RuntimePermissionRequest`, `RuntimeQuestionRequest`), answered over the
 * routes the product already calls (`/permission/:id/reply`,
 * `/question/:id/reply|reject`).
 */
import { randomUUID } from 'node:crypto'
import type {
  RuntimePermissionReply,
  RuntimePermissionRequest,
  RuntimeQuestion,
  RuntimeQuestionRequest,
  RuntimeToolRef,
} from '@kortix/api-contract/transcript'
import { permissionSubject, toolCapability, resolvePolicyRule, type PermissionPolicy, type PermissionRule } from '../permission-policy'
import type { RuntimeFrame } from './transcript'

export type PermissionReply = RuntimePermissionReply

export { compilePermissionPolicy, wildcardMatch, permissionSubject, toolCapability, registeredSkillAgents, resolvePolicyRule, skillGranted } from '../permission-policy'
export type { PermissionRule, PermissionRuleConfig, PermissionPolicy } from '../permission-policy'

export class PermissionBroker {
  private readonly pending = new Map<string, { request: RuntimePermissionRequest; resolve: (reply: PermissionReply) => void }>()
  private readonly alwaysAllowed = new Set<string>()

  constructor(
    private readonly sessionID: string,
    private readonly publish: (frame: RuntimeFrame) => void,
    private policy: PermissionPolicy = {},
    private readonly onAsked?: (request: RuntimePermissionRequest) => void,
  ) {}

  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy
  }

  rule(tool: string, args?: unknown): PermissionRule {
    const resolved = resolvePolicyRule(this.policy, tool, args)
    // A deny outranks an earlier "always": approving `ls` must not unlock the
    // `rm -rf *` the same pattern map denies.
    if (resolved === 'deny') return 'deny'
    if (this.alwaysAllowed.has(toolCapability(tool, args))) return 'allow'
    return resolved ?? 'allow'
  }

  /** Resolves with the user's reply; never rejects. */
  ask(input: { tool: string; args: unknown; ref?: RuntimeToolRef }): Promise<PermissionReply> {
    const request: RuntimePermissionRequest = {
      id: `perm_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      sessionID: this.sessionID,
      // The capability, so "always" covers every tool that shares it (`write` and `edit`).
      permission: toolCapability(input.tool, input.args),
      patterns: [permissionSubject(input.tool, input.args) ?? '*'],
      metadata: input.args && typeof input.args === 'object' ? (input.args as Record<string, unknown>) : {},
      always: ['*'],
      ...(input.ref ? { tool: input.ref } : {}),
    }
    return new Promise<PermissionReply>((resolve) => {
      this.pending.set(request.id, { request, resolve })
      this.publish({ type: 'permission.asked', properties: { ...request } })
      this.onAsked?.(request)
    })
  }

  reply(id: string, reply: PermissionReply): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    if (reply === 'always') this.alwaysAllowed.add(entry.request.permission)
    this.publish({ type: 'permission.replied', properties: { sessionID: this.sessionID, requestID: id, reply } })
    entry.resolve(reply)
    return true
  }

  list(): RuntimePermissionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  /** A turn that ends (abort, error) releases every request it left open. */
  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.reply(id, 'reject')
  }
}

export class QuestionBroker {
  private readonly pending = new Map<string, { request: RuntimeQuestionRequest; resolve: (answers: string[][] | null) => void }>()

  constructor(
    private readonly sessionID: string,
    private readonly publish: (frame: RuntimeFrame) => void,
    private readonly onAsked?: (request: RuntimeQuestionRequest) => void,
  ) {}

  /** Resolves with the answers, or null when rejected; never rejects. */
  ask(questions: RuntimeQuestion[], ref?: RuntimeToolRef): Promise<string[][] | null> {
    const request: RuntimeQuestionRequest = {
      id: `que_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      sessionID: this.sessionID,
      questions,
      ...(ref ? { tool: ref } : {}),
    }
    return new Promise((resolve) => {
      this.pending.set(request.id, { request, resolve })
      this.publish({ type: 'question.asked', properties: { ...request } })
      this.onAsked?.(request)
    })
  }

  reply(id: string, answers: string[][]): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    this.publish({ type: 'question.replied', properties: { sessionID: this.sessionID, requestID: id, answers } })
    entry.resolve(answers)
    return true
  }

  reject(id: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    this.publish({ type: 'question.rejected', properties: { sessionID: this.sessionID, requestID: id } })
    entry.resolve(null)
    return true
  }

  list(): RuntimeQuestionRequest[] {
    return [...this.pending.values()].map((entry) => entry.request)
  }

  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.reject(id)
  }
}
