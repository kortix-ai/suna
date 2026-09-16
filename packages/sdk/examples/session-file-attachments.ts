// npm: import { createKortix } from '@kortix/sdk';
import { createKortix } from '../src/index';

const client = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_TOKEN!,
});
const session = client.session(process.env.KORTIX_PROJECT_ID!, process.env.KORTIX_SESSION_ID!);
const file = await session.attachments.file(new TextEncoder().encode('name,total\nKortix,42\n'), {
  contentType: 'text/csv', filename: 'report.csv',
});
await session.send('Read the uploaded CSV and report the total.', { files: [file] });
