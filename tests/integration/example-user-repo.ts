import type { Client } from 'pg';
import type { User } from '../_support/factories';

export async function migrate(client: Client): Promise<void> {
  await client.query(`
    create table if not exists users (
      id text primary key,
      email text not null unique,
      name text not null,
      is_platform_admin boolean not null default false,
      created_at timestamptz not null default now()
    )
  `);
}

export async function insertUser(client: Client, user: User): Promise<void> {
  await client.query(
    'insert into users (id, email, name, is_platform_admin) values ($1, $2, $3, $4)',
    [user.id, user.email, user.name, user.isPlatformAdmin],
  );
}

export async function findByEmail(client: Client, email: string): Promise<Pick<User, 'id' | 'email' | 'name'> | null> {
  const result = await client.query('select id, email, name from users where email = $1', [email]);
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return { id: row.id, email: row.email, name: row.name };
}

export async function countAdmins(client: Client): Promise<number> {
  const result = await client.query('select count(*)::int as n from users where is_platform_admin');
  return result.rows[0].n;
}
