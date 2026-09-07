import { randomUUID } from 'node:crypto';
import type { QuestionAnswer, QuestionInfo, QuestionRequest } from '@opencode-ai/sdk/v2';

export type QuestionEvent =
  | { type: 'question.asked'; properties: QuestionRequest }
  | {
      type: 'question.replied';
      properties: { sessionID: string; requestID: string; answers: QuestionAnswer[] };
    }
  | {
      type: 'question.rejected';
      properties: { sessionID: string; requestID: string };
    };

interface PendingQuestion {
  request: QuestionRequest;
  resolve: (answers: QuestionAnswer[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class QuestionRejectedError extends Error {
  constructor(requestId: string) {
    super(`question ${requestId} was rejected by the user`);
    this.name = 'QuestionRejectedError';
  }
}

export interface QuestionBrokerOptions {
  sessionId: string;
  publish: (event: QuestionEvent) => void;
  createId?: () => string;
}

function cloneRequest(request: QuestionRequest): QuestionRequest {
  return structuredClone(request);
}

function validateQuestions(questions: readonly QuestionInfo[]): void {
  if (questions.length === 0) throw new TypeError('questions must contain at least one question');
  for (const [index, question] of questions.entries()) {
    if (!question.question.trim()) throw new TypeError(`questions[${index}].question is required`);
    if (!question.header.trim()) throw new TypeError(`questions[${index}].header is required`);
    if (question.header.length > 30) {
      throw new TypeError(`questions[${index}].header must contain at most 30 characters`);
    }
    if (!Array.isArray(question.options) || question.options.length === 0) {
      throw new TypeError(`questions[${index}].options must contain at least one option`);
    }
    for (const [optionIndex, option] of question.options.entries()) {
      if (!option.label.trim()) {
        throw new TypeError(`questions[${index}].options[${optionIndex}].label is required`);
      }
      if (!option.description.trim()) {
        throw new TypeError(`questions[${index}].options[${optionIndex}].description is required`);
      }
    }
  }
}

function validateAnswers(request: QuestionRequest, answers: readonly QuestionAnswer[]): void {
  if (answers.length !== request.questions.length) {
    throw new TypeError('answers must contain one answer per question');
  }
  for (const [index, answer] of answers.entries()) {
    if (!Array.isArray(answer) || answer.length === 0) {
      throw new TypeError(`answers[${index}] must contain at least one selection`);
    }
    const question = request.questions[index];
    if (!question) {
      throw new TypeError(`answers[${index}] does not match a question`);
    }
    if (!question.multiple && answer.length > 1) {
      throw new TypeError(`answers[${index}] accepts one selection`);
    }
    const labels = new Set(question.options.map((option) => option.label));
    for (const selection of answer) {
      if (typeof selection !== 'string' || !selection.trim()) {
        throw new TypeError(`answers[${index}] contains an invalid selection`);
      }
      if (!labels.has(selection) && question.custom === false) {
        throw new TypeError(`answers[${index}] selection is not an available option`);
      }
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('question was aborted');
}

/**
 * Owns the pending question lifecycle for one Pi worker process.
 *
 * A question is tied to an active tool call. It is intentionally ephemeral:
 * Stop and worker replacement terminate that tool call, publish rejection, and
 * let the durable turn journal record the interrupted turn. A stale request can
 * therefore never be answered after the model operation that created it died.
 */
export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly createId: () => string;

  constructor(private readonly options: QuestionBrokerOptions) {
    this.createId = options.createId ?? (() => `que_${randomUUID().replaceAll('-', '')}`);
  }

  list(): QuestionRequest[] {
    return [...this.pending.values()].map((item) => cloneRequest(item.request));
  }

  ask(
    questions: readonly QuestionInfo[],
    options: { signal?: AbortSignal; tool?: QuestionRequest['tool'] } = {},
  ): Promise<QuestionAnswer[]> {
    validateQuestions(questions);
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    const id = this.createId();
    if (!id || this.pending.has(id))
      throw new Error(`question id ${id || '<empty>'} is not unique`);
    const request: QuestionRequest = {
      id,
      sessionID: this.options.sessionId,
      questions: structuredClone([...questions]),
      ...(options.tool ? { tool: structuredClone(options.tool) } : {}),
    };

    return new Promise<QuestionAnswer[]>((resolve, reject) => {
      const pending: PendingQuestion = { request, resolve, reject, signal: options.signal };
      const signal = options.signal;
      if (signal) {
        pending.onAbort = () => this.cancelForAbort(id, abortError(signal));
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        this.options.publish({ type: 'question.asked', properties: cloneRequest(request) });
      } catch (error) {
        this.take(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  reply(requestId: string, answers: QuestionAnswer[]): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    validateAnswers(pending.request, answers);
    this.take(requestId);
    const cloned = structuredClone(answers);
    this.options.publish({
      type: 'question.replied',
      properties: { sessionID: this.options.sessionId, requestID: requestId, answers: cloned },
    });
    pending.resolve(cloned);
    return true;
  }

  reject(requestId: string): boolean {
    const pending = this.take(requestId);
    if (!pending) return false;
    this.options.publish({
      type: 'question.rejected',
      properties: { sessionID: this.options.sessionId, requestID: requestId },
    });
    pending.reject(new QuestionRejectedError(requestId));
    return true;
  }

  private cancelForAbort(requestId: string, error: Error): void {
    const pending = this.take(requestId);
    if (!pending) return;
    this.options.publish({
      type: 'question.rejected',
      properties: { sessionID: this.options.sessionId, requestID: requestId },
    });
    pending.reject(error);
  }

  private take(requestId: string): PendingQuestion | null {
    const pending = this.pending.get(requestId);
    if (!pending) return null;
    this.pending.delete(requestId);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    return pending;
  }
}
