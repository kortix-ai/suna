import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { createScopedKortix } from '@kortix/sdk/server';
import {
  type AuthSession,
  type AuthUser,
  createAuthUser,
  deleteAuthUser,
  signIn,
} from '../helpers/session-auth';

const enabled = process.env.E2E_ENABLE_WHITELABEL_PARITY === '1';
const keepProjects = process.env.E2E_KEEP_WHITELABEL_PARITY_PROJECTS === '1';
const apiBase = process.env.E2E_API_URL || 'http://localhost:16708/v1';
const whiteLabelBase = process.env.E2E_WHITELABEL_URL || 'http://localhost:3010';
const supabaseUrl = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const databaseUrl =
  process.env.E2E_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'WhiteLabelParity123!';
const testCreditBalance = 100;
const acpQuestionReconnectDelayMs = Number(
  process.env.E2E_WHITELABEL_ACP_QUESTION_RECONNECT_DELAY_MS ?? 121_000,
);
if (!Number.isFinite(acpQuestionReconnectDelayMs) || acpQuestionReconnectDelayMs < 0) {
  throw new Error('E2E_WHITELABEL_ACP_QUESTION_RECONNECT_DELAY_MS must be a non-negative number');
}
const prompt =
  'Research Marko Kraemer using the available web research tools. Create a PowerPoint presentation about Marko Kraemer and save it under /workspace. Do not ask a clarifying question. Complete the presentation, verify the file, and summarize the result.';

interface ProjectFixture {
  projectId: string;
  sessionId: string;
  transport: 'acp' | 'rest';
}

interface SurfaceEvidence {
  transport: 'acp' | 'rest';
  acpPromptCount: number;
  restPromptCount: number;
  toolCards: string[];
  transcript: string;
  presentationPath: string;
  presentationBytes: number;
}

async function answerBetaQuestion(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Beta/ }).last().click();
  const submitAnswer = page.getByRole('button', {
    name: 'Submit answer',
    exact: true,
  });
  if (await submitAnswer.isVisible().catch(() => false)) await submitAnswer.click();
  await expect(page.getByText('QUESTION_BETA', { exact: true }).last()).toBeVisible({
    timeout: 120_000,
  });
}

async function waitForReadySession(
  kortix: ReturnType<typeof createScopedKortix>,
  fixture: ProjectFixture,
): Promise<void> {
  const deadline = Date.now() + 12 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const result = await kortix.session(fixture.projectId, fixture.sessionId).start(8_000);
    last = `${result?.stage ?? 'none'}:${result?.sandbox?.status ?? 'none'}:${result?.runtime_transport ?? 'none'}`;
    if (result?.stage === 'failed' || result?.sandbox?.status === 'failed') {
      throw new Error(`Session failed before readiness: ${last}`);
    }
    if (
      result?.stage === 'ready' &&
      result.sandbox?.status === 'active' &&
      result.sandbox.external_id &&
      result.runtime_transport === fixture.transport
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Session did not become ready: ${last}`);
}

async function retryCleanup(label: string, operation: () => Promise<unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw new Error(`${label} failed after 3 attempts`, { cause: lastError });
}

async function createParityAuth(email: string): Promise<{
  user: AuthUser;
  auth: AuthSession;
}> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const user = await createAuthUser(email, { supabaseUrl, password });
      const auth = await signIn(email, { supabaseUrl, password });
      return { user, auth };
    } catch (error) {
      lastError = error;
      try {
        const auth = await signIn(email, { supabaseUrl, password });
        return { user: auth.user, auth };
      } catch {
        if (attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
        }
      }
    }
  }
  throw new Error('Parity auth fixture failed after 5 attempts', {
    cause: lastError,
  });
}

async function runSurface(
  page: Page,
  auth: AuthSession,
  kortix: ReturnType<typeof createScopedKortix>,
  fixture: ProjectFixture,
  testInfo: TestInfo,
): Promise<SurfaceEvidence> {
  const acpPrompts: string[] = [];
  const restPrompts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/kortix/acp/')) {
      const body = request.postData();
      if (body?.includes('"method":"session/prompt"')) acpPrompts.push(body);
    }
    if (request.url().includes('/prompt_async')) restPrompts.push(request.url());
  });

  await page.addInitScript((token) => {
    window.localStorage.setItem('kortix_api_key', token);
  }, auth.access_token);
  await page.goto(`${whiteLabelBase}/projects/${fixture.projectId}/sessions/${fixture.sessionId}`, {
    waitUntil: 'domcontentloaded',
  });

  const input = page.getByPlaceholder(/Message the agent/);
  await expect(input).toBeVisible({ timeout: 120_000 });
  const stop = page.getByLabel('Stop', { exact: true });
  await input.fill(prompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(stop).toBeVisible({ timeout: 120_000 });
  await expect(stop).toBeHidden({ timeout: 15 * 60_000 });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Agent is working…', { exact: true })).toBeHidden();
  await expect(page.locator('[data-message-role="assistant"]').last()).toBeVisible({
    timeout: 120_000,
  });
  const renderedToolCards = page.locator('[data-slot="tool-call"]');
  await expect(renderedToolCards.first()).toBeVisible({ timeout: 120_000 });
  await expect(
    page.locator(
      '[data-slot="tool-call"][data-tool-status="pending"], [data-slot="tool-call"][data-tool-status="running"]',
    ),
  ).toHaveCount(0);
  await expect(page.locator('main')).toContainText(/\/workspace\/\S+\.pptx\b/i, {
    timeout: 120_000,
  });
  await expect(page.locator('main')).toContainText(/\b\d+\s+slides?\b/i, {
    timeout: 120_000,
  });

  const sessionFiles = kortix.session(fixture.projectId, fixture.sessionId).files;
  let presentationPath = '';
  await expect
    .poll(
      async () => {
        try {
          const files = await sessionFiles.list('/workspace');
          const presentation = files.find(
            (file) => file.type === 'file' && file.name.toLowerCase().endsWith('.pptx'),
          );
          presentationPath = presentation?.absolute || presentation?.path || '';
          return presentationPath;
        } catch {
          return '';
        }
      },
      { timeout: 120_000 },
    )
    .toMatch(/\.pptx$/i);
  let presentationBytes = 0;
  await expect
    .poll(
      async () => {
        try {
          presentationBytes = (await sessionFiles.readBlob(presentationPath)).size;
          return presentationBytes;
        } catch {
          return 0;
        }
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThan(10_000);

  const screenshotPath = testInfo.outputPath(`${fixture.transport}-presentation.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${fixture.transport}-presentation`, {
    path: screenshotPath,
    contentType: 'image/png',
  });

  const transcript = await page.locator('main').innerText();
  expect(transcript).not.toContain('Out of credits');
  const toolCards = await renderedToolCards.evaluateAll((cards) =>
    cards
      .map((card) => card.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter((text) => text.length > 0),
  );
  await testInfo.attach(`${fixture.transport}-transcript`, {
    body: transcript,
    contentType: 'text/plain',
  });

  await input.fill(
    'Use the question tool to ask "Choose one" with options Alpha and Beta. If I choose Beta, reply with exactly QUESTION_BETA.',
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Choose one', { exact: true }).last()).toBeVisible({
    timeout: 120_000,
  });
  if (fixture.transport === 'acp') {
    await new Promise((resolve) => setTimeout(resolve, acpQuestionReconnectDelayMs));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Choose one', { exact: true }).last()).toBeVisible({
      timeout: 120_000,
    });
  }
  await answerBetaQuestion(page);

  return {
    transport: fixture.transport,
    acpPromptCount: acpPrompts.length,
    restPromptCount: restPrompts.length,
    toolCards,
    transcript,
    presentationPath,
    presentationBytes,
  };
}

test.describe.serial('16 — white-label ACP and REST parity', () => {
  test.skip(!enabled, 'Set E2E_ENABLE_WHITELABEL_PARITY=1 for the real dual-project flow.');
  test.setTimeout(60 * 60_000);

  let user: AuthUser;
  let auth: AuthSession;
  let kortix: ReturnType<typeof createScopedKortix>;
  const fixtures: ProjectFixture[] = [];
  const cleanupFixtures: ProjectFixture[] = [];

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(40 * 60_000);
    const email = `whitelabel-parity-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
    ({ user, auth } = await createParityAuth(email));
    kortix = createScopedKortix({
      backendUrl: apiBase,
      getToken: async () => auth.access_token,
    });
    const accounts = (await kortix.accounts.list()) as Array<{
      account_id: string;
      personal_account?: boolean;
    }>;
    const account = accounts.find((item) => item.personal_account) ?? accounts[0];
    expect(account?.account_id).toBeTruthy();

    execFileSync(
      'psql',
      [
        databaseUrl,
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `INSERT INTO kortix.credit_accounts (
           account_id,
           balance,
           balance_precise,
           non_expiring_credits,
           non_expiring_credits_precise,
           tier
         )
         VALUES (
           '${account.account_id}',
           ${testCreditBalance},
           ${testCreditBalance},
           ${testCreditBalance},
           ${testCreditBalance},
           'tier_2_20'
         )
         ON CONFLICT (account_id)
         DO UPDATE SET
           balance = ${testCreditBalance},
           balance_precise = ${testCreditBalance},
           non_expiring_credits = ${testCreditBalance},
           non_expiring_credits_precise = ${testCreditBalance},
           tier = 'tier_2_20'`,
      ],
      { stdio: 'ignore' },
    );

    for (const transport of ['acp', 'rest'] as const) {
      const project = await kortix.projects.provision({
        account_id: account.account_id,
        name: `White-label ${transport.toUpperCase()} parity ${Date.now()}`,
        seed_starter: true,
      });
      const projectHandle = kortix.project(project.project_id);
      await projectHandle.onboardingComplete(true);
      await projectHandle.modelDefaults.set({
        scope: 'project',
        model: 'claude-sonnet-4.6',
      });
      await projectHandle.updateExperimentalFeature('acp_runtime', transport === 'acp');
      let readyFixture: ProjectFixture | null = null;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const session = await projectHandle.sessions.create({
          name: `${transport.toUpperCase()} presentation parity ${attempt}`,
          agent_name: 'kortix',
          opencode_model: 'kortix/claude-sonnet-4.6',
        });
        const fixture = {
          projectId: project.project_id,
          sessionId: session.session_id,
          transport,
        };
        cleanupFixtures.push(fixture);
        try {
          await waitForReadySession(kortix, fixture);
          readyFixture = fixture;
          break;
        } catch (error) {
          lastError = error;
          await kortix
            .session(fixture.projectId, fixture.sessionId)
            .delete()
            .catch(() => {});
        }
      }
      if (!readyFixture) throw lastError;
      fixtures.push(readyFixture);
    }
  });

  test.afterAll(async ({}, testInfo) => {
    testInfo.setTimeout(3 * 60_000);
    if (!keepProjects) {
      const cleanupErrors: Error[] = [];
      for (const fixture of cleanupFixtures) {
        await retryCleanup(`delete session ${fixture.sessionId}`, () =>
          kortix.session(fixture.projectId, fixture.sessionId).delete(),
        ).catch((error) => {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        });
      }
      for (const projectId of new Set(cleanupFixtures.map((fixture) => fixture.projectId))) {
        await retryCleanup(`archive project ${projectId}`, () =>
          kortix.project(projectId).archive(),
        ).catch((error) => {
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        });
      }
      if (user?.id) {
        await deleteAuthUser(user.id, {
          supabaseUrl,
          envFiles: ['apps/api/.env', 'apps/web/.env'],
        });
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'White-label parity cleanup failed');
      }
    }
  });

  test('runs the same presentation and question flow through both transports', async ({
    browser,
  }, testInfo) => {
    const evidence: SurfaceEvidence[] = [];
    for (const fixture of fixtures) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      evidence.push(await runSurface(page, auth, kortix, fixture, testInfo));
      await context.close();
    }

    const acp = evidence.find((item) => item.transport === 'acp')!;
    const rest = evidence.find((item) => item.transport === 'rest')!;
    expect(acp.acpPromptCount).toBeGreaterThanOrEqual(2);
    expect(acp.restPromptCount).toBe(0);
    expect(rest.acpPromptCount).toBe(0);
    expect(rest.restPromptCount).toBeGreaterThanOrEqual(2);
    expect(acp.toolCards.length).toBeGreaterThanOrEqual(10);
    expect(rest.toolCards.length).toBeGreaterThanOrEqual(10);
    expect(
      Math.min(acp.toolCards.length, rest.toolCards.length) /
        Math.max(acp.toolCards.length, rest.toolCards.length),
    ).toBeGreaterThanOrEqual(0.5);

    await testInfo.attach('transport-comparison', {
      body: JSON.stringify(
        {
          fixtures,
          acp: {
            acpPromptCount: acp.acpPromptCount,
            restPromptCount: acp.restPromptCount,
            toolCards: acp.toolCards,
            presentationPath: acp.presentationPath,
            presentationBytes: acp.presentationBytes,
          },
          rest: {
            acpPromptCount: rest.acpPromptCount,
            restPromptCount: rest.restPromptCount,
            toolCards: rest.toolCards,
            presentationPath: rest.presentationPath,
            presentationBytes: rest.presentationBytes,
          },
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  });
});
