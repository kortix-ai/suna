import { Data, Effect } from 'effect';
import {
  ImageSearchRequestSchema,
  WebSearchRequestSchema,
  type BillingDeductResult,
  type ImageSearchResponse,
  type WebSearchResponse,
} from '../../types';
import type { z } from 'zod';
import { checkCredits, deductToolCredits } from './billing';
import { runEffectOrThrow } from '../../effect/http';
import { imageSearchSerper } from './serper';
import { webSearchTavily } from './tavily';

type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;
type ImageSearchRequest = z.infer<typeof ImageSearchRequestSchema>;

export class InsufficientCreditsError extends Data.TaggedError('InsufficientCreditsError')<{
  readonly message: string;
}> {}

export class CreditCheckError extends Data.TaggedError('CreditCheckError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SearchProviderError extends Data.TaggedError('SearchProviderError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SearchBillingError extends Data.TaggedError('SearchBillingError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type SearchWorkflowError =
  | InsufficientCreditsError
  | CreditCheckError
  | SearchProviderError
  | SearchBillingError;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ensureCredits = (accountId: string) =>
  Effect.tryPromise({
    try: () => checkCredits(accountId),
    catch: (cause) =>
      new CreditCheckError({
        message: `Credit check failed: ${errorMessage(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((creditCheck) =>
      creditCheck.hasCredits
        ? Effect.succeed(creditCheck)
        : Effect.fail(new InsufficientCreditsError({ message: creditCheck.message })),
    ),
  );

const deductToolCreditsEffect = (
  accountId: string,
  toolName: string,
  resultCount: number,
  description: string,
  sessionId?: string,
) =>
  Effect.tryPromise({
    try: () => deductToolCredits(accountId, toolName, resultCount, description, sessionId),
    catch: (cause) =>
      new SearchBillingError({
        message: `Billing failed: ${errorMessage(cause)}`,
        cause,
      }),
  });

const warnReturnedBillingFailure = (accountId: string, billingResult: BillingDeductResult) =>
  Effect.sync(() => {
    if (!billingResult.success && !billingResult.skipped) {
      console.warn(`[KORTIX] Billing failed for ${accountId} but returning results anyway`);
    }
  });

const searchProvider = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new SearchProviderError({
        message: errorMessage(cause),
        cause,
      }),
  });

export const webSearchWorkflowEffect = (accountId: string, request: WebSearchRequest) =>
  Effect.gen(function* () {
    const toolName = `web_search_${request.search_depth}`;

    yield* ensureCredits(accountId);

    const results = yield* searchProvider(() =>
      webSearchTavily(request.query, request.max_results, request.search_depth),
    );

    const billingResult = yield* deductToolCreditsEffect(
      accountId,
      toolName,
      results.length,
      `Web search: ${request.query.slice(0, 50)}`,
      request.session_id,
    );

    yield* warnReturnedBillingFailure(accountId, billingResult);

    return {
      results,
      query: request.query,
      cost: billingResult.cost,
    } satisfies WebSearchResponse;
  });

export const imageSearchWorkflowEffect = (accountId: string, request: ImageSearchRequest) =>
  Effect.gen(function* () {
    yield* ensureCredits(accountId);

    const results = yield* searchProvider(() =>
      imageSearchSerper(request.query, request.max_results, request.safe_search),
    );

    const billingResult = yield* deductToolCreditsEffect(
      accountId,
      'image_search',
      results.length,
      `Image search: ${request.query.slice(0, 50)}`,
      request.session_id,
    );

    yield* warnReturnedBillingFailure(accountId, billingResult);

    return {
      results,
      query: request.query,
      cost: billingResult.cost,
    } satisfies ImageSearchResponse;
  });

export const runWebSearchWorkflow = (accountId: string, request: WebSearchRequest) =>
  runEffectOrThrow(webSearchWorkflowEffect(accountId, request));

export const runImageSearchWorkflow = (accountId: string, request: ImageSearchRequest) =>
  runEffectOrThrow(imageSearchWorkflowEffect(accountId, request));
