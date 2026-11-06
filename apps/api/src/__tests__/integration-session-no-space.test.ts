/**
 * Integration test (real local PostgreSQL): the space a new session is filed in
 * under the `chat` flag (`resolveRequestedSessionSpace`). A person's own create
 * with `space_id: null` (the regular new-session composer) is filed in no space,
 * as with the flag off. Without it, the create is filed as before: `#general`
 * (`filed: true`, no space named), a named channel, a fork's source space.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { projectSessions, projectSpaces, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { resolveRequestedSessionSpace } from '../projects/lib/session-create';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const PERSON = crypto.randomUUID();
const CHANNEL = crypto.randomUUID();
const THREAD = crypto.randomUUID();
let chatOn: SeededProject;
let chatOff: SeededProject;

type Input = Parameters<typeof resolveRequestedSessionSpace>[0];

async function resolve(project: SeededProject, body: Record<string, unknown>) {
  const [row] = await db.select().from(projects).where(eq(projects.projectId, project.project_id));
  return resolveRequestedSessionSpace({
    project: row,
    userId: PERSON,
    requestingPrincipalType: 'human',
    body,
  } as unknown as Input);
}

beforeAll(async () => {
  chatOn = await seedProject('no-space-on', { metadata: { experimental: { chat: true } } });
  chatOff = await seedProject('no-space-off', { accountId: chatOn.account_id });
  const base = { accountId: chatOn.account_id, projectId: chatOn.project_id };
  await db.insert(projectSpaces).values({ ...base, spaceId: CHANNEL, kind: 'channel', slug: 'launch', name: 'launch', createdBy: PERSON });
  await db.insert(projectSessions).values({
    ...base,
    sessionId: THREAD,
    branchName: `session/${THREAD}`,
    createdBy: PERSON,
    visibility: 'project',
    spaceId: CHANNEL,
  });
});

afterAll(async () => {
  await db.delete(projectSessions).where(eq(projectSessions.projectId, chatOn.project_id));
  await db.delete(projectSpaces).where(eq(projectSpaces.projectId, chatOn.project_id));
  await removeSeeded([chatOff, chatOn]);
});

test('chat on: a person’s create with space_id null is filed in no space (filed false), as with the flag off', async () => {
  expect(await resolve(chatOn, { space_id: null, initial_prompt: 'hi' })).toEqual({ filed: false, spaceId: null });
  expect(await resolve(chatOff, { space_id: null, initial_prompt: 'hi' })).toEqual({ filed: false, spaceId: null });
});

test('chat on: without the signal the create is filed as before: #general (filed, no space named) or the named channel', async () => {
  // `filed: true` with no space: createProjectSession files it in `#general`.
  expect(await resolve(chatOn, { initial_prompt: 'hi' })).toEqual({ filed: true, spaceId: null });
  expect(await resolve(chatOn, { space_id: CHANNEL })).toEqual({ filed: true, spaceId: CHANNEL, visibility: 'project' });
});

test('chat on: a fork with space_id null keeps its source’s space (null reads as absent there)', async () => {
  const fork = await resolve(chatOn, { fork_from_session_id: THREAD, space_id: null });
  expect(fork).toMatchObject({ filed: true, spaceId: CHANNEL });
});
