import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let count = 0;
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  if (method === 'initialize')
    return send(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'fixture', version: '1' },
    });
  if (method === 'tools/list')
    return send(id, {
      tools: [
        {
          name: params.cursor ? 'second' : 'counter',
          description: 'Count calls',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      ...(params.cursor ? {} : { nextCursor: 'page2' }),
    });
  if (method === 'resources/list')
    return send(id, { resources: [{ uri: 'fixture://value', name: 'Value' }] });
  if (method === 'resources/templates/list')
    return send(id, {
      resourceTemplates: [
        { uriTemplate: 'fixture://{name}', name: 'Named value' },
      ],
    });
  if (method === 'resources/read')
    return send(id, {
      contents: [
        { uri: params.uri, text: 'RESOURCE_OK', mimeType: 'text/plain' },
      ],
    });
  if (method === 'prompts/list')
    return send(id, {
      prompts: [{ name: 'review', description: 'Review fixture' }],
    });
  if (method === 'prompts/get')
    return send(id, {
      messages: [
        { role: 'user', content: { type: 'text', text: 'PROMPT_OK' } },
      ],
    });
  if (method !== 'tools/call') return send(id, {});
  if (params.name === 'grandchild') {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    return send(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ pid: process.pid, child: child.pid }),
        },
      ],
    });
  }
  if (params.name === 'schema') return send(id, { content: 'invalid' });
  if (params.name === 'rpc_error')
    return process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid fixture arguments' },
      }) + '\n',
    );
  if (params.name === 'crash') process.exit(3);
  if (params.name === 'invalid') return process.stdout.write('not-json\n');
  if (params.name === 'oversize')
    return process.stdout.write('x'.repeat(13 * 1024 * 1024));
  if (params.name === 'error')
    return send(id, {
      content: [{ type: 'text', text: 'FIXTURE_ERROR' }],
      isError: true,
    });
  if (params.name === 'sleep') {
    writeFileSync('started', String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 60000));
    writeFileSync('late', 'bad');
  }
  if (params.name === 'write')
    writeFileSync(params.arguments.path, params.arguments.text);
  send(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          count: ++count,
          pid: process.pid,
          cwd: process.cwd(),
          environment: process.env.FIXTURE_VALUE ?? null,
          privateToken: process.env.KORTIX_TOKEN ?? null,
          arguments: params.arguments,
        }),
      },
    ],
  });
});
