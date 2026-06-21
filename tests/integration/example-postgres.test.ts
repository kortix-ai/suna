import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { isDockerAvailable } from './docker-available';
import { countAdmins, findByEmail, insertUser, migrate } from './example-user-repo';
import { userFactory } from '../_support/factories';

const dockerUp = await isDockerAvailable();
const describeWithDocker = dockerUp ? describe : describe.skip;

if (!dockerUp) {
  console.warn('[integration] Docker unavailable — skipping Postgres testcontainer suite. Set SKIP_DOCKER_TESTS=1 to force-skip.');
}

describeWithDocker('user repository against real Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrate(client);
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it('round-trips a user by email', async () => {
    const user = userFactory();
    await insertUser(client, user);

    const found = await findByEmail(client, user.email);
    expect(found).toEqual({ id: user.id, email: user.email, name: user.name });
  });

  it('enforces the unique email constraint', async () => {
    const user = userFactory();
    await insertUser(client, user);
    await expect(insertUser(client, { ...userFactory(), email: user.email })).rejects.toThrow();
  });

  it('counts platform admins', async () => {
    const before = await countAdmins(client);
    await insertUser(client, userFactory({ isPlatformAdmin: true }));
    expect(await countAdmins(client)).toBe(before + 1);
  });
});
