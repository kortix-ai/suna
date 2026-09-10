import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compilePiAgentModule } from './pi-agent-module';
import { compilePiRuntime } from './compiled-pi-runtime';

async function waitFor<T>(read: () => T | Promise<T>, matches: (value: T) => boolean) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (matches(value)) return value;
    await Bun.sleep(25);
  }
  throw new Error('Compiled custom Pi runtime did not become ready');
}

test('standalone Node artifacts load distinct custom agents, use environment RPC, and run graceful shutdown', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-custom-runtime-')));
  const effects: string[] = [];
  const logs = new Map<string, any[]>();
  const keys = new Map<string, string>();
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const requestPath = new URL(request.url).pathname.replace(/\/agent-state$/, '/log');
      if (requestPath.startsWith('/log/')) {
        expect(request.headers.get('authorization')).toBe('Bearer runtime-token');
        const items = logs.get(requestPath) ?? [];
        logs.set(requestPath, items);
        if (request.method === 'GET') return Response.json(items);
        const item = await request.json();
        if (item.stream === 'kortix.pi.agent-state.v1' && item.record.namespace === 'conflict')
          return Response.json({ code: 'PI_STATE_CONFLICT' }, { status: 409 });
        const key = requestPath + request.headers.get('idempotency-key');
        const encoded = JSON.stringify(item);
        if (keys.has(key))
          return new Response(null, { status: keys.get(key) === encoded ? 204 : 409 });
        keys.set(key, encoded);
        items.push(item);
        return new Response(null, { status: 204 });
      }
      const body = (await request.json()) as any;
      if (new URL(request.url).pathname.startsWith('/rpc')) {
        effects.push(body.args.command);
        return Response.json({
          ok: true,
          value: { stdout: body.args.command, stderr: '', exitCode: 0 },
        });
      }
      const lastUser = body.messages.findLastIndex((message: any) => message.role === 'user');
      const results = body.messages
        .slice(lastUser + 1)
        .filter((message: any) => message.role === 'tool');
      const tool = body.tools?.find((tool: any) => tool.function.name.startsWith('custom_'))
        ?.function.name;
      const delta = results.length
        ? { role: 'assistant', content: results.at(-1).content }
        : {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'custom-call',
                type: 'function',
                function: { name: tool, arguments: '{"value":"proof"}' },
              },
            ],
          };
      return new Response(
        [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [
              { index: 0, delta: {}, finish_reason: results.length ? 'stop' : 'tool_calls' },
            ],
          },
        ]
          .map(
            (frame) =>
              'data: ' +
              JSON.stringify({ id: 'compiled-proof', model: body.model, ...frame }) +
              '\n\n',
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const bundlePath = join(root, 'worker-runtime.mjs');
  const build = Bun.spawn(
    [
      process.execPath,
      'build',
      'src/main.ts',
      '--target=node',
      '--format=esm',
      '--outfile=' + bundlePath,
    ],
    { cwd: resolve(import.meta.dir, '../../../kortix-worker'), stdout: 'pipe', stderr: 'pipe' },
  );
  const buildError = new Response(build.stderr).text();
  expect(await build.exited).toBe(0);
  expect(await buildError).toBe('');
  const workerBundle = await readFile(bundlePath, 'utf8');
  const hashes: string[] = [];
  try {
    for (const name of ['reviewer', 'operator']) {
      const module = await compilePiAgentModule({
        entry: `agents/${name}.ts`,
        files: {
          [`agents/${name}.ts`]: `
import {definePiAgent,PiStateConflictError} from '@kortix/sdk/pi';
import {Type} from 'typebox';
export default definePiAgent(ctx=>({
 async initialize(){
   const counter=await ctx.state.open('counter',{schemaVersion:1,initialValue:0});
   console.log('STATE_${name} '+(await counter.read()).value);
   console.log('INIT_${name} '+ctx.sourceSha);
 },
 shutdown(){console.log('SHUTDOWN_${name}');},
 afterToolCall:async({result})=>({content:[...result.content,{type:'text',text:'HOOK_${name}'}]}),
 tools:[{name:'custom_${name}',label:'Custom',description:'Run custom proof',parameters:Type.Object({value:Type.String()}),
 execute:async(_id,{value})=>{
   try {await ctx.state.open('conflict',{schemaVersion:1,initialValue:0});throw new Error('expected conflict');}
   catch(error){if(!(error instanceof PiStateConflictError))throw new Error('cross-bundle state error lost its identity');}
   const counter=await ctx.state.open('counter',{schemaVersion:1,initialValue:0});
   const saved=await counter.update(n=>n+1);
   ${name === 'operator' ? `const result=await ctx.env.exec('ENV_'+value);if(!result.ok)throw result.error;const text=result.value.stdout;` : `const text='JS_'+value;`}
   return {content:[{type:'text',text:text+' COUNT_'+saved.value}],details:{agent:ctx.agentName}};
 }}]
}));`,
        },
      });
      const artifact = compilePiRuntime({
        projectId: 'project-proof',
        ref: 'main',
        sourceSha: 'a'.repeat(40),
        defaultAgent: name,
        agentConfig: JSON.stringify({
          agent: { [name]: { model: 'openai/gpt-4.1', permission: 'allow', steps: 3 } },
        }),
        workerBundle,
        agentModule: module,
      });
      hashes.push(artifact.sha256);
      const path = join(root, name + '.mjs');
      await writeFile(path, artifact.source);
      let transcript: any[] | undefined;
      for (let replacement = 0; replacement < 2; replacement++) {
        const child = Bun.spawn(
          ['node', '--permission', `--allow-fs-read=${path}`, '--allow-fs-read=/proc/uptime', path],
          {
            env: {
              PATH: process.env.PATH!,
              KORTIX_SERVICE_PORT: '0',
              KORTIX_SESSION_ID: 'custom-' + name,
              KORTIX_MODEL_MODE: 'real',
              KORTIX_GATEWAY_URL: provider.url.toString().replace(/\/$/, '') + '/v1',
              KORTIX_API_KEY: 'fixture-token',
              KORTIX_TOKEN: 'runtime-token',
              KORTIX_ENV_URL: provider.url.toString().replace(/\/$/, '') + '/rpc',
              KORTIX_ENV_TRANSPORT: 'fetch',
              KORTIX_STORE_URL: provider.url.toString().replace(/\/$/, '') + '/log/' + name,
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        let stdout = '';
        const output = (async () => {
          for await (const chunk of child.stdout) stdout += Buffer.from(chunk).toString();
        })();
        const errors = new Response(child.stderr).text();
        try {
          const port = await waitFor(
            () => {
              const lines = stdout.split('\n');
              for (const line of lines) {
                try {
                  const row = JSON.parse(line);
                  if (row.msg === 'worker listening') return row.port as number;
                } catch {}
              }
              return 0;
            },
            (value) => value > 0,
          );
          const base = 'http://127.0.0.1:' + port;
          const headers = {
            authorization: 'Bearer runtime-token',
            'content-type': 'application/json',
          };
          const sessions = (await (await fetch(base + '/session', { headers })).json()) as any[];
          if (transcript)
            expect(
              await (await fetch(base + `/session/${sessions[0].id}/message`, { headers })).json(),
            ).toEqual(transcript);
          const response = await fetch(base + `/session/${sessions[0].id}/message`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ parts: [{ type: 'text', text: 'Use the custom tool.' }] }),
          });
          expect(response.status).toBe(200);
          const result = (await response.json()) as any;
          expect(result.info.error).toBeUndefined();
          expect(result.parts.some((part: any) => part.text?.includes('HOOK_' + name))).toBe(true);
          expect(result.parts.some((part: any) => part.text?.includes('COUNT_' + (replacement + 1)))).toBe(true);
          expect(stdout).toContain('STATE_' + name + ' ' + replacement);
          expect(stdout.split('INIT_' + name).length - 1).toBe(1);
          expect(stdout).toContain('INIT_' + name + ' ' + 'a'.repeat(40));
          transcript = (await (
            await fetch(base + `/session/${sessions[0].id}/message`, { headers })
          ).json()) as any[];
          child.kill('SIGTERM');
          expect(await child.exited).toBe(0);
          await output;
          expect(stdout.split('SHUTDOWN_' + name).length - 1).toBe(1);
          expect(await errors).not.toContain('fatal');
        } catch (error) {
          child.kill('SIGKILL');
          await child.exited;
          await output;
          throw new Error(
            String(error) + '\nWorker output: ' + stdout + '\nWorker error: ' + (await errors),
          );
        } finally {
          child.kill('SIGKILL');
          await child.exited;
          await output;
        }
      }
    }
    expect(new Set(hashes).size).toBe(2);
    expect(effects).toEqual(['ENV_proof', 'ENV_proof']);
  } finally {
    provider.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
