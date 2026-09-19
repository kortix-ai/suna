import { expect, test } from '@playwright/test';
import { loadEnv } from '../../src/core/env';
import { createDatabaseSession } from '../../src/fixtures/database-project';
import { seedSessionTranscript } from '../../src/fixtures/session-transcript';
import { queryDatabaseRows, runDatabaseSql } from '../helpers/database';
import { createApiJsonClient } from '../helpers/http';
import { createManifestProject, fundAccount } from '../helpers/manifest-project';
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from '../helpers/session-auth';
import {
  dismissOnboarding,
  dismissWelcomeCard,
  featureFlagRow,
  selectAccountForUi,
} from '../helpers/ui';

const imageFixture = {
  name: 'wake-image.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC',
    'base64',
  ),
};

const api = createApiJsonClient(process.env.E2E_API_URL!);
const authOptions = {
  supabaseUrl: process.env.E2E_SUPABASE_URL!,
  password: 'TranscriptHistory123!',
};

test('30 — saved session history paints while sandbox start and the open bundle are pending', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const env = loadEnv();
  const email = `transcript-history-${Date.now()}@example.test`;
  const user = await createAuthUser(email, authOptions);
  const auth = await signIn(email, authOptions);
  let projectId = '';
  let sessionId = '';
  let disposeProject = async () => {};
  let releaseReads = () => {};
  let releaseSend = () => {};
  try {
    const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
      auth.access_token,
      'GET',
      '/accounts',
    );
    const accountId = (accounts.find((a) => a.personal_account) ?? accounts[0]).account_id;
    await fundAccount(env.databaseUrl!, accountId);
    const project = await createManifestProject({
      api,
      accessToken: auth.access_token,
      databaseUrl: env.databaseUrl!,
      accountId,
      userId: user.id,
      name: 'Transcript history verification',
    });
    projectId = project.id;
    disposeProject = project.dispose;
    sessionId = await createDatabaseSession(env, {
      projectId,
      accountId,
      userId: user.id,
    });
    await seedSessionTranscript(env, { projectId, accountId, sessionId });
    await runDatabaseSql(
      "UPDATE kortix.project_sessions SET agent_name='kortix' WHERE session_id=$1",
      [sessionId],
      env.databaseUrl,
    );
    await installBrowserSessionDirect(page, auth, `/projects/${projectId}`, authOptions);
    await selectAccountForUi(page, accountId);
    await dismissOnboarding(page);
    await page.goto(`/projects/${projectId}/settings/feature-flags`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('heading', { name: 'Feature flags', exact: true })).toBeVisible();
    const row = featureFlagRow(page.locator('body'), page, 'Session Transcript History');
    const toggle = row.getByRole('switch');
    await expect(toggle).not.toBeChecked();
    const patched = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/projects/${projectId}/features`) && r.request().method() === 'PATCH',
    );
    await toggle.click();
    const changed = await patched;
    expect(changed.status()).toBe(200);
    expect(changed.request().postDataJSON()).toEqual({
      feature: 'session_transcript_history',
      enabled: true,
    });
    await expect(toggle).toBeChecked();

    const held = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let startRequested = false;
    let startResponded = false;
    let snapshotRequested = false;
    page.on('response', (response) => {
      if (response.url().includes(`/sessions/${sessionId}/start`)) startResponded = true;
    });
    await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
      startRequested = true;
      await held;
      await route.continue().catch(() => {});
    });
    await page.route(`**/sessions/${sessionId}/snapshot*`, async (route) => {
      snapshotRequested = true;
      await held;
      await route.continue().catch(() => {});
    });
    const history = page.waitForResponse(
      (r) =>
        r.url().includes(`/sessions/${sessionId}/transcript?`) && r.url().includes('history=true'),
    );
    await page.goto(`/projects/${projectId}/sessions/${sessionId}`, {
      waitUntil: 'domcontentloaded',
    });
    const response = await history;
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.source).toBe('mirror');
    expect(body.message_count).toBe(2);
    await expect(
      page.getByText('This reply is stored in the database.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Show my saved conversation.', { exact: true })).toBeVisible();
    await expect.poll(() => startRequested).toBe(true);
    await expect.poll(() => snapshotRequested).toBe(true);
    expect(startResponded).toBe(false);
    await dismissWelcomeCard(page);
    for (const close of await page.getByRole('button', { name: 'Close notification' }).all())
      await close.click();
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('history-before-sandbox-ready.png'),
      fullPage: true,
    });
    const pendingSend = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    await page.route(`**/sessions/${sessionId}/prompts`, async (route) => {
      if (route.request().method() === 'POST') await pendingSend;
      await route.continue().catch(() => {});
    });
    const editor = page.locator('[contenteditable="true"]').first();
    await page
      .locator('input[type="file"]')
      .last()
      .setInputFiles([
        imageFixture,
        {
          name: 'wake-notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('Saved before sandbox startup.'),
        },
      ]);
    await editor.fill('Continue while the computer starts.');
    const send = page.getByRole('button', {
      name: 'Send message',
      exact: true,
    });
    await expect(send).toBeEnabled();
    const submitted = page.waitForRequest(
      (r) => r.url().endsWith(`/sessions/${sessionId}/prompts`) && r.method() === 'POST',
    );
    await send.click();
    const request = await submitted;
    const promptParts = request.postDataJSON().parts;
    expect(promptParts).toHaveLength(3);
    expect(promptParts[0]).toEqual({
      type: 'text',
      text: 'Continue while the computer starts.',
    });
    for (const part of promptParts.slice(1)) {
      expect(part.attachment_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(promptParts.slice(1).every((part: { url?: string }) => !part.url)).toBe(true);
    const preview = page.getByRole('img', {
      name: 'wake-image.png',
      exact: true,
    });
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(1);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'wake-notes.txt', exact: false }).click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe('wake-notes.txt');
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('Saved before sandbox startup.');
    await expect(
      page.getByText('Continue while the computer starts.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('session-busy-indicator')).toBeVisible();
    await expect(page.getByTestId('session-busy-indicator')).toContainText('Thinking');
    await expect(
      page.getByText('Starting your computer… your message will send automatically.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(editor).toHaveText('');
    expect(startResponded).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath('send-before-sandbox-ready.png'),
      fullPage: true,
    });
    const accepted = page.waitForResponse(
      (r) => r.url().endsWith(`/sessions/${sessionId}/prompts`) && r.request().method() === 'POST',
    );
    releaseSend();
    expect((await accepted).status()).toBe(202);
    const inbox = await api<{ prompts: Array<{ text: string }> }>(
      auth.access_token,
      'GET',
      `/projects/${projectId}/sessions/${sessionId}/prompts`,
    );
    expect(inbox.prompts.some((p) => p.text === 'Continue while the computer starts.')).toBe(true);
    releaseReads();
    await expect(
      page.getByText('This reply is stored in the database.', { exact: true }),
    ).toHaveCount(1);
  } finally {
    releaseReads();
    releaseSend();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    if (projectId) {
      if (sessionId)
        await api(auth.access_token, 'DELETE', `/projects/${projectId}/sessions/${sessionId}`);
      await runDatabaseSql(
        "UPDATE kortix.project_sessions SET metadata = metadata || jsonb_build_object('deletedAt', now()::text) WHERE project_id = $1",
        [projectId],
        env.databaseUrl,
      );
      await runDatabaseSql(
        'DELETE FROM kortix.session_sandboxes WHERE project_id = $1',
        [projectId],
        env.databaseUrl,
      );
      await disposeProject();
    }
    await deleteAuthUser(user.id, {
      supabaseUrl: authOptions.supabaseUrl,
      envFiles: ['apps/api/.env', 'apps/web/.env'],
    });
  }
});

interface SavedHistory {
  source: string;
  messages: Array<{
    info: {
      id: string;
      role: string;
      parentID?: string;
      time: { completed?: number };
    };
    parts: Array<{ type: string; text?: string }>;
  }>;
}

if (process.env.E2E_ENABLE_SDK_ONLY_SESSION === '1') {
  test('30 — real replies survive stop and a prompt sent during wake runs once', async ({
    page,
  }, testInfo) => {
    test.setTimeout(20 * 60_000);
    const env = loadEnv();
    const suffix = Date.now().toString(36).toUpperCase();
    const firstReply = `HISTORY_FIRST_${suffix}`;
    const secondReply = `HISTORY_SECOND_${suffix}`;
    const legacyReply = `HISTORY_LEGACY_${suffix}`;
    const prompt = (reply: string) =>
      reply === secondReply
        ? 'Read the attached wake-notes.txt file with a tool. Reply with exactly its contents, without other text.'
        : 'Read the attached first-notes.txt file with a tool. Reply with exactly its contents, without other text.';
    const email = `transcript-live-${Date.now()}@example.test`;
    const user = await createAuthUser(email, authOptions);
    const auth = await signIn(email, authOptions);
    let projectId = '';
    let sessionId = '';
    let releaseStart = () => {};
    const submittedIds: string[] = [];
    let reusedAccountId: string | undefined;
    try {
      const accounts = await api<Array<{ account_id: string; personal_account?: boolean }>>(
        auth.access_token,
        'GET',
        '/accounts',
      );
      let accountId = (accounts.find((a) => a.personal_account) ?? accounts[0]).account_id;
      const reusableProjectId = process.env.E2E_TRANSCRIPT_REUSE_PROJECT_ID;
      if (reusableProjectId) {
        expect(process.env.KE2E_TARGET).toBe('preview');
        const health = await api<{ environment: string }>(auth.access_token, 'GET', '/health');
        expect(health.environment).toBe('preview');
        const reusable = await queryDatabaseRows<{ account_id: string }>(
          `SELECT p.account_id FROM kortix.projects p
           JOIN kortix.project_git_connections g ON g.project_id=p.project_id
           WHERE p.project_id=$1 AND p.status='archived' AND p.name LIKE 'Live transcript %'
             AND g.managed=true AND g.provider='github' AND g.credential_ref IS NULL`,
          [reusableProjectId],
          env.databaseUrl,
        );
        expect(reusable).toHaveLength(1);
        accountId = reusable[0].account_id;
        reusedAccountId = accountId;
        projectId = reusableProjectId;
        await runDatabaseSql(
          `INSERT INTO kortix.account_members (account_id,user_id,account_role) VALUES ($1,$2,'owner')`,
          [accountId, user.id],
          env.databaseUrl,
        );
        await runDatabaseSql(
          `INSERT INTO kortix.project_members (account_id,project_id,user_id,project_role,granted_by)
           VALUES ($1,$2,$3,'manager',$3)`,
          [accountId, projectId, user.id],
          env.databaseUrl,
        );
        await runDatabaseSql(
          "UPDATE kortix.projects SET status='active' WHERE project_id=$1",
          [projectId],
          env.databaseUrl,
        );
      } else {
        await fundAccount(env.databaseUrl!, accountId);
        const project = await api<{ project_id: string }>(
          auth.access_token,
          'POST',
          '/projects/provision',
          { account_id: accountId, name: `Live transcript ${suffix}`, seed_starter: true },
          201,
        );
        projectId = project.project_id;
      }
      await fundAccount(env.databaseUrl!, accountId);
      await api(auth.access_token, 'PATCH', `/projects/${projectId}/onboarding`, {
        completed: true,
      });
      await api(auth.access_token, 'PATCH', `/projects/${projectId}/features`, {
        feature: 'session_transcript_history',
        enabled: true,
      });
      const imageModel = 'gpt-5.6-luna';
      const picker = await api<{ models: Record<string, { attachment?: boolean }> }>(
        auth.access_token,
        'GET',
        `/projects/${projectId}/model-picker`,
      );
      expect(picker.models[imageModel]?.attachment).toBe(true);
      await api(auth.access_token, 'PUT', `/projects/${projectId}/model-defaults`, {
        scope: 'project',
        model: imageModel,
      });
      const session = await api<{ session_id: string }>(
        auth.access_token,
        'POST',
        `/projects/${projectId}/sessions`,
        {
          name: `Live transcript ${suffix}`,
          opencode_model: imageModel,
          pending_prompt: {
            text: prompt(firstReply),
            parts: [
              { type: 'text', text: prompt(firstReply) },
              {
                type: 'file',
                filename: 'first-image.png',
                mime: imageFixture.mimeType,
                url: `data:${imageFixture.mimeType};base64,${imageFixture.buffer.toString('base64')}`,
              },
              {
                type: 'file',
                filename: 'first-notes.txt',
                mime: 'text/plain',
                url: `data:text/plain;base64,${Buffer.from(firstReply).toString('base64')}`,
              },
            ],
          },
        },
        201,
      );
      sessionId = session.session_id;
      const sessionPath = `/projects/${projectId}/sessions/${sessionId}`;
      const readHistory = () =>
        api<SavedHistory>(
          auth.access_token,
          'GET',
          `${sessionPath}/transcript?shape=sync&history=true`,
        );
      const textOf = (message: SavedHistory['messages'][number]) =>
        message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('');
      const savedReply = (history: SavedHistory, text: string) =>
        history.messages.filter(
          (message) =>
            message.info.role === 'assistant' &&
            message.info.time.completed &&
            textOf(message).trim().replace(/^`([^`\n]+)`$/, '$1') === text,
        );
      await test.step('a real cloud sandbox reaches ready', async () => {
        await expect
          .poll(
            async () => {
              const result = await api<{
                stage: string;
                sandbox?: { status?: string };
              }>(auth.access_token, 'POST', `${sessionPath}/start?wait_ms=8000`, {});
              return `${result.stage}:${result.sandbox?.status}`;
            },
            { timeout: 12 * 60_000, intervals: [2_000, 5_000] },
          )
          .toBe('ready:active');
      });
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith(`${sessionPath}/prompts`)) {
          submittedIds.push(request.postDataJSON().message_id);
        }
      });
      await installBrowserSessionDirect(page, auth, sessionPath, authOptions);
      await selectAccountForUi(page, accountId);
      await dismissOnboarding(page);
      await dismissWelcomeCard(page);
      const editor = page.getByRole('textbox', { name: 'Message input' });
      await test.step('a streamed reply reaches the database before manual stop', async () => {
        await expect(editor).toBeVisible({ timeout: 120_000 });
        await expect(page.getByText(firstReply, { exact: true })).toBeVisible({
          timeout: 180_000,
        });
        await expect
          .poll(async () => savedReply(await readHistory(), firstReply).length, {
            timeout: 90_000,
            intervals: [1_000, 2_000],
          })
          .toBe(1);
        expect((await readHistory()).source).toBe('mirror');
        const firstDelivery = await queryDatabaseRows<{ requested_id: string }>(
          "SELECT payload->>'wireMessageId' AS requested_id FROM kortix.session_lifecycle_commands WHERE session_id=$1 AND payload->>'clientMessageId'=$2",
          [sessionId, `pending:${sessionId}`],
          env.databaseUrl,
        );
        expect(firstDelivery).toHaveLength(1);
        submittedIds.push(firstDelivery[0].requested_id);
        const firstUser = (await readHistory()).messages.find(
          (message) => message.info.role === 'user',
        )!;
        const firstText = textOf(firstUser);
        expect(firstText).toContain('filename="first-image.png"');
        expect(firstText).toContain('filename="first-notes.txt"');
        expect([...firstText.matchAll(/attachment="kortix-attachment:\/\//g)]).toHaveLength(2);
      });
      const originalIds = (await readHistory()).messages.map((message) => message.info.id);
      await page.goto(`/projects/${projectId}/settings/feature-flags`, {
        waitUntil: 'domcontentloaded',
      });
      await api(auth.access_token, 'POST', `${sessionPath}/stop`, {});
      await expect
        .poll(
          async () => {
            const rows = await queryDatabaseRows<{ status: string }>(
              'SELECT status FROM kortix.session_sandboxes WHERE session_id=$1',
              [sessionId],
              env.databaseUrl,
            );
            return rows[0]?.status;
          },
          { timeout: 60_000 },
        )
        .toBe('stopped');
      expect(savedReply(await readHistory(), firstReply)).toHaveLength(1);
      const waiting = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      let startRequested = false;
      await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
        startRequested = true;
        await waiting;
        await route.continue().catch(() => {});
      });
      await test.step('saved history and the sent message paint before wake completes', async () => {
        const history = page.waitForResponse(
          (r) => r.url().includes(`${sessionPath}/transcript?`) && r.url().includes('history=true'),
        );
        await page.goto(sessionPath, { waitUntil: 'domcontentloaded' });
        expect((await history).status()).toBe(200);
        await expect(page.getByText(firstReply, { exact: true })).toBeVisible();
        await expect.poll(() => startRequested).toBe(true);
        await page
          .locator('input[type="file"]')
          .last()
          .setInputFiles([
            imageFixture,
            {
              name: 'wake-notes.txt',
              mimeType: 'text/plain',
              buffer: Buffer.from(secondReply),
            },
          ]);
        await editor.fill(prompt(secondReply));
        const accepted = page.waitForResponse(
          (r) => r.request().method() === 'POST' && r.url().endsWith(`${sessionPath}/prompts`),
        );
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect(page.getByText(prompt(secondReply), { exact: true })).toBeVisible();
        await expect(page.getByTestId('session-busy-indicator')).toContainText('Thinking');
        const acceptedResponse = await accepted;
        expect(acceptedResponse.status()).toBe(202);
        const sentParts = acceptedResponse.request().postDataJSON().parts;
        expect(sentParts).toHaveLength(3);
        for (const part of sentParts.slice(1))
          expect(part.attachment_id).toMatch(/^[0-9a-f-]{36}$/);
        await expect(page.getByRole('img', { name: 'wake-image.png', exact: true })).toBeVisible();
        await page.screenshot({
          path: testInfo.outputPath('real-send-during-wake.png'),
          fullPage: true,
        });
        releaseStart();
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      });
      await test.step('the queued prompt runs once and both turns persist', async () => {
        await expect(page.getByText(secondReply, { exact: true })).toBeVisible({
          timeout: 240_000,
        });
        await expect
          .poll(async () => savedReply(await readHistory(), secondReply).length, {
            timeout: 90_000,
            intervals: [1_000, 2_000],
          })
          .toBe(1);
        const history = await readHistory();
        expect(history.source).toBe('mirror');
        expect(savedReply(history, firstReply)).toHaveLength(1);
        expect(submittedIds).toHaveLength(2);
        expect(new Set(submittedIds).size).toBe(2);
        const deliveries = await queryDatabaseRows<{
          requested_id: string;
          delivered_id: string;
          state: string;
        }>(
          `SELECT payload->>'wireMessageId' AS requested_id,
                  result->>'forwarded_message_id' AS delivered_id,
                  result->>'status' AS state
             FROM kortix.session_lifecycle_commands
            WHERE session_id=$1 AND payload->>'wireMessageId'=ANY($2::text[])`,
          [sessionId, submittedIds],
          env.databaseUrl,
        );
        await testInfo.attach('persisted-transcript.json', {
          body: JSON.stringify(
            { projectId, sessionId, submittedIds, deliveries, history },
            null,
            2,
          ),
          contentType: 'application/json',
        });
        expect(deliveries).toHaveLength(2);
        for (const delivery of deliveries) {
          expect(delivery.state).toBe('delivered');
          expect(
            history.messages.filter((message) => message.info.id === delivery.delivered_id),
          ).toHaveLength(1);
        }
        for (const id of originalIds)
          expect(history.messages.map((message) => message.info.id)).toContain(id);
        for (const reply of [firstReply, secondReply]) {
          const messages = history.messages.filter(
            (message) => message.info.role === 'user' && textOf(message).startsWith(prompt(reply)),
          );
          expect(messages).toHaveLength(1);
          expect(savedReply(history, reply)[0].info.parentID).toBe(messages[0].info.id);
        }
      });
      await test.step('enabling history recovers an older inline image and sandbox file', async () => {
        await api(auth.access_token, 'PATCH', `/projects/${projectId}/features`, {
          feature: 'session_transcript_history',
          enabled: false,
        });
        const legacyPrompt =
          'Read the attached legacy-notes.txt file with a tool. Reply with exactly its contents, without other text.';
        await api(
          auth.access_token,
          'POST',
          `${sessionPath}/prompts`,
          {
            client_message_id: `legacy-${suffix}`,
            message_id: `msg_${(Date.now() * 4096).toString(16).slice(-12).padStart(12, '0')}legacy00000001`,
            parts: [
              { type: 'text', text: legacyPrompt },
              {
                type: 'file',
                filename: 'legacy-image.png',
                mime: imageFixture.mimeType,
                url: `data:${imageFixture.mimeType};base64,${imageFixture.buffer.toString('base64')}`,
              },
              {
                type: 'file',
                filename: 'legacy-notes.txt',
                mime: 'text/plain',
                url: `data:text/plain;base64,${Buffer.from(legacyReply).toString('base64')}`,
              },
            ],
          },
          202,
        );
        await expect(page.getByText(legacyReply, { exact: true })).toBeVisible({
          timeout: 240_000,
        });
        await api(auth.access_token, 'PATCH', `/projects/${projectId}/features`, {
          feature: 'session_transcript_history',
          enabled: true,
        });
      });
      await test.step('saved attachments and completed replies load while the computer is stopped', async () => {
        await page.goto(`/projects/${projectId}/settings/feature-flags`, {
          waitUntil: 'domcontentloaded',
        });
        await api(auth.access_token, 'POST', `${sessionPath}/stop`, {});
        const held = new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
        await page.route(`**/sessions/${sessionId}/start*`, async (route) => {
          await held;
          await route.continue().catch(() => {});
        });
        await page.goto(sessionPath, { waitUntil: 'domcontentloaded' });
        const savedImage = page.getByRole('img', {
          name: 'wake-image.png',
          exact: true,
        });
        await expect(savedImage).toBeVisible();
        await expect
          .poll(() => savedImage.evaluate((node) => (node as HTMLImageElement).naturalWidth))
          .toBe(1);
        const downloaded = page.waitForEvent('download');
        await page.getByRole('button', { name: 'wake-notes.txt txt', exact: true }).click();
        const file = await downloaded;
        const stream = await file.createReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString()).toBe(secondReply);
        for (const [imageName, textName, expectedText] of [
          ['first-image.png', 'first-notes.txt', firstReply],
          ['legacy-image.png', 'legacy-notes.txt', legacyReply],
        ]) {
          const image = page.getByRole('img', { name: imageName, exact: true });
          await expect(image).toBeVisible();
          await expect
            .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
            .toBe(1);
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: `${textName} txt`, exact: true }).click();
          const stream = await (await download).createReadStream();
          const chunks: Buffer[] = [];
          for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
          expect(Buffer.concat(chunks).toString()).toBe(expectedText);
        }
        await expect(page.getByText(legacyReply, { exact: true })).toHaveCount(1);
        await expect(page.getByText(firstReply, { exact: true })).toHaveCount(1);
        await expect(page.getByText(secondReply, { exact: true })).toHaveCount(1);
        await page.screenshot({
          path: testInfo.outputPath('real-replies-after-reload.png'),
          fullPage: true,
        });
      });
    } finally {
      releaseStart();
      if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' });
      if (projectId) {
        const sessions = await queryDatabaseRows<{ session_id: string }>(
          'SELECT session_id FROM kortix.project_sessions WHERE project_id=$1',
          [projectId],
          env.databaseUrl,
        );
        const removed = await Promise.allSettled(
          sessions.map((session) =>
            api(
              auth.access_token,
              'DELETE',
              `/projects/${projectId}/sessions/${session.session_id}`,
              undefined,
              [200, 404],
            ),
          ),
        );
        for (const result of removed) {
          if (result.status === 'rejected') throw result.reason;
        }
        await api(auth.access_token, 'DELETE', `/projects/${projectId}`);
      }
      if (reusedAccountId) {
        await runDatabaseSql(
          'DELETE FROM kortix.project_members WHERE project_id=$1 AND user_id=$2',
          [projectId, user.id],
          env.databaseUrl,
        );
        await runDatabaseSql(
          'DELETE FROM kortix.account_members WHERE account_id=$1 AND user_id=$2',
          [reusedAccountId, user.id],
          env.databaseUrl,
        );
      }
      await deleteAuthUser(user.id, {
        supabaseUrl: authOptions.supabaseUrl,
        envFiles: ['apps/api/.env', 'apps/web/.env'],
      });
    }
  });
}
