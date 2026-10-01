import { BINARY_INLINE_CHARS, IMAGE_MAX_BYTES, ToolInputError, apiResult, arg, bounded, callApi, callSandbox, envRpcResult, expandHome, intArg, needTarget, optionalArg, page, pageLines, projectArg, resolveSandbox, sandboxExec, sleep, text, type ToolContext, type ToolResult } from './common';
import { JOB_CANCEL, JOB_DEFAULT_TIMEOUT_SECONDS, JOB_LAUNCH, JOB_MAX_TIMEOUT_SECONDS, JOB_POLL, JOB_TAIL_BYTES, parseJobPoll, renderJob, type JobState } from './jobs';

export async function dispatchSandbox(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult | undefined> {
  switch (name) {
    case 'run_command': {
      const started = Date.now();
      const sessionId = arg(input, 'session_id');
      const existing = optionalArg(input, 'job_id');
      if (existing && !/^[0-9a-f]{16}$/.test(existing)) throw new ToolInputError('job_id is the 16-character id a running result returned');
      if (existing && optionalArg(input, 'command')) throw new ToolInputError('pass command (start a command) or job_id (follow one), not both');
      if (input.cancel === true && !existing) throw new ToolInputError('cancel needs the job_id of a running command');
      const rawTimeout = input.timeout_seconds;
      if (rawTimeout !== undefined && rawTimeout !== null && !(Number(rawTimeout) > 0)) throw new ToolInputError('timeout_seconds must be a positive number');
      const command = existing ? undefined : arg(input, 'command');
      const jobId = existing ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      // One session lookup for the launch and every poll of this call.
      const sandbox = await resolveSandbox(ctx, sessionId);
      if (!('session' in sandbox)) return apiResult(sandbox);
      const exec = (script: string, env: Record<string, string>, cwd?: string) => sandboxExec(ctx, sandbox, script, { KMCP_JOB: jobId, ...env }, cwd);
      let finishedBefore = false;
      if (existing && input.cancel === true) {
        const r = await exec(JOB_CANCEL, {});
        if ('error' in r) return r.error;
        finishedBefore = r.stdout.trim() === 'finished';
      } else if (!existing) {
        const timeout = bounded(rawTimeout, JOB_DEFAULT_TIMEOUT_SECONDS, JOB_MAX_TIMEOUT_SECONDS);
        const r = await exec(JOB_LAUNCH, { KMCP_CMD: command!, KMCP_TIMEOUT: String(timeout) }, optionalArg(input, 'cwd'));
        if ('error' in r) return r.error;
        // A launch that fails (a cwd that does not exist, no space left) says why, before any poll.
        if (r.exitCode !== 0) return text(`Could not start the command (exit ${r.exitCode}): ${r.stderr.trim() || 'no error output'}`, true);
      }
      // Wait for the exit file, fast at first (most commands finish in well
      // under a second), then every second, leaving ~6 s for the final read.
      const sep = `--kortix-mcp-${crypto.randomUUID()}--`;
      const poll = async (): Promise<{ error: ToolResult } | { job: JobState }> => {
        const r = await exec(JOB_POLL, { KMCP_TAIL: String(JOB_TAIL_BYTES), KMCP_SEP: sep });
        return 'error' in r ? r : { job: parseJobPoll(r.stdout, sep) };
      };
      let delay = 200;
      for (;;) {
        const r = await poll();
        if ('error' in r) return r.error;
        if (r.job.state === 'missing') return text(`No job ${jobId} in this session's sandbox (a restarted sandbox loses its jobs).`, true);
        if (r.job.state === 'done' || Date.now() + delay > ctx.deadline - 6_000) {
          const rendered = renderJob(jobId, r.job, Date.now() - started);
          return text(finishedBefore && r.job.state === 'done' ? `job already finished (${r.job.exit === 'cancelled' ? 'cancelled' : `exit ${r.job.exit}`})\n${rendered}` : rendered);
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 1_000);
      }
    }
    case 'read_file': {
      const path = arg(input, 'path');
      needTarget(input);
      const sessionId = optionalArg(input, 'session_id');
      if (!sessionId) {
        const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/files/content`, { query: { path, ref: optionalArg(input, 'ref') } });
        if (r.status >= 400) return apiResult(r);
        const file = JSON.parse(r.body);
        // The route returns git's stdout as a string; a NUL byte means binary, never text.
        if (String(file.content).includes('\0')) return text(`${path} is a binary file. Read it through a session (read_file with session_id) or clone the repository.`);
        return pageLines(file.content, input);
      }
      const sandbox = await resolveSandbox(ctx, sessionId);
      if (!('session' in sandbox)) return apiResult(sandbox);
      const home = await expandHome(ctx, sandbox, path);
      if ('error' in home) return home.error;
      const r = await callSandbox(ctx, sandbox, 'GET', '/file/content', { query: { path: home.path } });
      if (r.status >= 400) return apiResult(r);
      const file = JSON.parse(r.body);
      if (file.type === 'text') return pageLines(file.content, input);
      if (String(file.mimeType).startsWith('image/')) {
        if (file.size > IMAGE_MAX_BYTES) return text(`Image (${file.mimeType}, ${file.size} bytes) is over the ${IMAGE_MAX_BYTES} byte limit for inline images. Resize it with run_command first.`);
        return { content: [{ type: 'image', data: file.content, mimeType: file.mimeType }] };
      }
      if (String(file.content).length > BINARY_INLINE_CHARS) {
        return text(`${home.path} is binary, ${file.size} bytes (${file.mimeType}) — use run_command (e.g. base64 -w0 ${home.path} | cut -c 1-40000) to fetch it.`);
      }
      return text(`Binary file (${file.mimeType}, ${file.size} bytes). Base64:\n${file.content}`);
    }
    case 'write_file': {
      const content = input.content;
      if (typeof content !== 'string') throw new ToolInputError('content is required');
      const base64 = input.encoding === 'base64';
      // Buffer.from(…, 'base64') is lenient: bad input would write junk bytes.
      if (base64 && (!/^[A-Za-z0-9+/=\s]*$/.test(content) || content.replace(/[=\s]/g, '').length % 4 === 1)) {
        throw new ToolInputError('content is not valid base64; nothing was written');
      }
      const sandbox = await resolveSandbox(ctx, arg(input, 'session_id'));
      if (!('session' in sandbox)) return apiResult(sandbox);
      const home = await expandHome(ctx, sandbox, arg(input, 'path'));
      if ('error' in home) return home.error;
      const r = await callSandbox(ctx, sandbox, 'POST', '/kortix/env-rpc', {
        body: { op: 'writeFile', args: { path: home.path, content, encoding: base64 ? 'base64' : 'utf8' } },
      });
      return envRpcResult(r, () => `wrote ${home.path}`);
    }
    case 'list_files': {
      needTarget(input);
      const path = optionalArg(input, 'path');
      const sessionId = optionalArg(input, 'session_id');
      const offset = intArg(input, 'offset') ?? 0;
      if (!sessionId) {
        const repoPath = path?.replace(/^\/+/, '');
        const ref = optionalArg(input, 'ref');
        const r = await callApi(ctx, 'GET', `/v1/projects/${projectArg(input)}/files`, { query: { path: repoPath, ref } });
        if (r.status >= 400) return apiResult(r);
        const files = JSON.parse(r.body) as { path: string }[];
        return text(files.length ? page(files.map((f) => f.path), offset, undefined, 'entries') : `No files${repoPath ? ` under ${repoPath}` : ''} at ${ref ? `${ref} (or that ref does not exist)` : 'the default branch'}.`);
      }
      const sandbox = await resolveSandbox(ctx, sessionId);
      if (!('session' in sandbox)) return apiResult(sandbox);
      const home = await expandHome(ctx, sandbox, path ?? '/workspace');
      if ('error' in home) return home.error;
      const r = await callSandbox(ctx, sandbox, 'GET', '/file', { query: { path: home.path } });
      if (r.status >= 400) return apiResult(r);
      const nodes = JSON.parse(r.body) as { absolute: string; type: string }[];
      return text(nodes.length ? page(nodes.map((n) => (n.type === 'directory' ? `${n.absolute}/` : n.absolute)), offset, undefined, 'entries') : 'Empty directory.');
    }
    default: return undefined;
  }
}
