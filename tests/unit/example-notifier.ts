import { sampleEnv } from '../_support/fixtures';

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

export async function notifyProjectCreated(mailer: Mailer, ownerEmail: string, projectName: string): Promise<void> {
  await mailer.send(
    ownerEmail,
    `Project ${projectName} is ready`,
    `View it at ${sampleEnv.KORTIX_WEB_URL}`,
  );
}
