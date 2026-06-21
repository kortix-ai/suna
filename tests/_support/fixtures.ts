import { projectFactory, resetSequence, userFactory, type Project, type User } from './factories';

export interface Workspace {
  admin: User;
  member: User;
  projects: Project[];
}

export function buildWorkspace(): Workspace {
  resetSequence();
  const admin = userFactory({ isPlatformAdmin: true });
  const member = userFactory();
  const projects = [
    projectFactory({ ownerId: admin.id }),
    projectFactory({ ownerId: member.id, archived: true }),
  ];
  return { admin, member, projects };
}

export const sampleEnv = {
  KORTIX_API_URL: 'http://localhost:8008',
  KORTIX_WEB_URL: 'http://localhost:3000',
} as const;

export function withEnv<T>(vars: Record<string, string>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
