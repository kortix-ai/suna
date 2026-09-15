import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { loadEnv } from "../../src/core/env";
import {
  createDatabaseProject,
  createDatabaseSession,
  deleteDatabaseProject,
} from "../../src/fixtures/database-project";
import { createApiJsonClient } from "../helpers/http";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";
import { dismissOnboarding, selectAccountForUi } from "../helpers/ui";

const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
const api = createApiJsonClient(apiBase);
const auth = {
  supabaseUrl: process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321",
  password: "StoppedHistoryE2e123!",
};
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPQrbhEEmIY1TCqYfhqAAC3o3cQrrmrGAAAAABJRU5ErkJggg==",
  "base64",
);

test("29 — stopped sessions keep saved text, image previews, and file downloads available without a sandbox", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const env = loadEnv();
  test.skip(
    !env.databaseUrl || env.target === "prod",
    "requires a non-production fixture database",
  );
  const email = `stopped-history-${Date.now()}@example.test`;
  const user = await createAuthUser(email, auth);
  const login = await signIn(email, auth);
  const database = new Client({
    connectionString: env.databaseUrl!,
    ssl: /localhost|127\.0\.0\.1/.test(env.databaseUrl!)
      ? false
      : { rejectUnauthorized: false },
  });
  let projectId: string | undefined;
  try {
    await database.connect();
    const accounts = await api<{ account_id: string }[]>(
      login.access_token,
      "GET",
      "/accounts",
    );
    const account = accounts[0]!;
    const project = await createDatabaseProject(env, {
      accountId: account.account_id,
      userId: user.id,
      name: "Stopped image history",
    });
    projectId = project.id;
    const sessionId = await createDatabaseSession(env, {
      projectId,
      accountId: account.account_id,
      userId: user.id,
    });
    const nativeId = "ses_stopped_image_history";
    const messageId = "msg_stopped_image_history";
    const marker = `Saved image history ${sessionId}`;
    const digest = createHash("sha256").update(imageBytes).digest("hex");
    const imagePath = `/projects/${projectId}/sessions/${sessionId}/attachments/${digest}`;
    const uploaded = await fetch(apiBase + imagePath, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${login.access_token}`,
        "content-type": "image/png",
      },
      body: imageBytes,
    });
    expect(uploaded.status).toBe(204);
    const documentBytes = Buffer.from('name,total\nKortix,42\n');
    const documentDigest = createHash('sha256').update(documentBytes).digest('hex');
    const documentPath = `/projects/${projectId}/sessions/${sessionId}/attachments/${documentDigest}`;
    const documentUpload = await fetch(apiBase + documentPath, {
      method: 'PUT', headers: { authorization: `Bearer ${login.access_token}`, 'content-type': 'text/csv' }, body: documentBytes,
    });
    expect(documentUpload.status).toBe(204);
    await database.query(
      "UPDATE kortix.project_sessions SET status='stopped', opencode_session_id=$2 WHERE session_id=$1",
      [sessionId, nativeId],
    );
    await database.query(
      `INSERT INTO kortix.session_transcript_mirrors (session_id,project_id,account_id,opencode_session_id,head_complete)
      SELECT session_id,project_id,account_id,$2,true FROM kortix.project_sessions WHERE session_id=$1`,
      [sessionId, nativeId],
    );
    const info = {
      id: messageId,
      sessionID: nativeId,
      role: "user",
      time: { created: Date.now() },
    };
    const parts = [
      { id: 'part_saved_document', sessionID: nativeId, messageID: messageId, type: 'file', filename: 'R&D report.csv', mime: 'text/csv', url: documentPath },
      {
        id: "part_saved_text",
        sessionID: nativeId,
        messageID: messageId,
        type: "text",
        text: marker,
      },
      {
        id: "part_saved_image",
        sessionID: nativeId,
        messageID: messageId,
        type: "file",
        filename: "saved-image.png",
        mime: "image/png",
        url: imagePath,
      },
    ];
    await database.query(
      `INSERT INTO kortix.session_transcript_messages (session_id,message_id,opencode_session_id,role,message_created_at,info,parts)
      VALUES ($1,$2,$3,'user',now(),$4::jsonb,$5::jsonb)`,
      [
        sessionId,
        messageId,
        nativeId,
        JSON.stringify(info),
        JSON.stringify(parts),
      ],
    );
    const imageResponses: number[] = [];
    page.on("response", (response) => {
      if (
        response.request().method() === "GET" &&
        response.url().endsWith(imagePath)
      )
        imageResponses.push(response.status());
    });
    const sessionPath = `/projects/${projectId}/sessions/${sessionId}`;
    await installBrowserSessionDirect(page, login, sessionPath, auth);
    await selectAccountForUi(page, account.account_id);
    await page.goto(sessionPath);
    await dismissOnboarding(page);
    for (let pass = 0; pass < 2; pass += 1) {
      if (pass > 0) await page.reload({ waitUntil: "domcontentloaded" });
      const chat = page.getByTestId("session-chat");
      await expect(chat.getByText(marker, { exact: true })).toBeVisible({
        timeout: 45_000,
      });
      const image = chat.locator('img[src^="blob:"]').first();
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate((element: HTMLImageElement) => element.naturalWidth),
        )
        .toBe(16);
      const bytes = await image.evaluate(async (element: HTMLImageElement) =>
        Array.from(
          new Uint8Array(await (await fetch(element.src)).arrayBuffer()),
        ),
      );
      expect(Buffer.from(bytes)).toEqual(imageBytes);
      const fileResponse = page.waitForResponse(response => response.url().endsWith(documentPath) && response.request().method() === 'GET');
      const downloadStarted = page.waitForEvent('download');
      await chat.getByRole('button', { name: /R&D report.csv/ }).click();
      expect((await fileResponse).status()).toBe(200);
      const download = await downloadStarted;
      expect(download.suggestedFilename()).toBe('R&D report.csv');
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(documentBytes);

      const current = await api<{ status: string }>(
        login.access_token,
        "GET",
        sessionPath,
      );
      expect(current.status).toBe("stopped");
      await expect(
        page.getByText("This session is stopped", { exact: true }),
      ).toHaveCount(0);
    }
    expect(imageResponses).toContain(200);
    const { rows } = await database.query(
      `SELECT (SELECT count(*) FROM kortix.session_sandboxes WHERE session_id=$1)::int AS sandboxes,
      (SELECT count(*) FROM kortix.session_environments WHERE session_id=$1)::int AS environments`,
      [sessionId],
    );
    expect(rows[0]).toEqual({ sandboxes: 0, environments: 0 });
    const emptyId = await createDatabaseSession(env, {
      projectId,
      accountId: account.account_id,
      userId: user.id,
    });
    await database.query(
      "UPDATE kortix.project_sessions SET status='stopped' WHERE session_id=$1",
      [emptyId],
    );
    await page.goto(`/projects/${projectId}/sessions/${emptyId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText("This session is stopped", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Restart session", exact: true }),
    ).toBeEnabled();
    await expect(page.getByTestId("session-chat")).toHaveCount(0);
  } finally {
    await database.end();
    if (projectId) await deleteDatabaseProject(env, projectId);
    await deleteAuthUser(user.id, auth);
  }
});
