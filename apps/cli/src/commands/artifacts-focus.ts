// `kortix artifacts` focus and types.
import { ApiError as SdkApiError, listArtifactTypes, signalArtifactLiveAgent, type ArtifactLiveAgentSignal } from '@kortix/sdk';
import { fail, featureDisabledMessage, missing } from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import { TYPES, short, type ArtifactsRun } from './artifacts-run.ts';

export async function artifactsFocus(sub: string, { pid, f, a0, resolve, out }: ArtifactsRun): Promise<number> {
  switch (sub) {
    case 'focus': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      const signal: ArtifactLiveAgentSignal = {
        status: (f.focusStatus ?? 'editing') as ArtifactLiveAgentSignal['status'],
        ...(f.thread ? { thread_id: f.thread } : {}),
        ...(f.quote !== undefined ? { quote: f.quote } : {}),
      };
      try {
        await signalArtifactLiveAgent(pid, id, signal);
      } catch (err) {
        // The route answers 403 to every token that is not bound to a session.
        if (err instanceof SdkApiError && err.status === 403 && !featureDisabledMessage(err)) {
          process.stderr.write(`${status.err('kortix artifacts focus is for agent sessions: run it inside a Kortix session. This token belongs to a person.')}\n`);
          return 1;
        }
        throw err;
      }
      const quote = signal.quote && signal.quote.length > 40 ? `${signal.quote.slice(0, 39)}…` : signal.quote;
      const where = signal.thread_id ? ` · thread ${signal.thread_id}` : quote ? ` · "${quote}"` : '';
      const line = signal.status === 'idle' ? `Left ${short(id)}` : `Focus ${signal.status} on ${short(id)}${where}`;
      return out({ artifact_id: id, ...signal }, status.ok(line));
    }
    default: {
      const types = await listArtifactTypes(pid);
      if (a0) {
        const t = types.find((x) => x.type === a0);
        if (!t) return fail(`unknown type "${a0}". One of ${TYPES.join(', ')}.`);
        if (f.json) return out(t, '');
        if (f.starter) return out(null, t.starter);
        process.stdout.write(`${C.bold}${t.name}${C.reset} (${t.type}): ${t.description}\n\nFormat:\n${t.format.split('\n').map((l) => `  - ${l}`).join('\n')}\n\nStarter:\n\n${t.starter}`);
        return 0;
      }
      if (f.json) return out(types, '');
      for (const t of types) process.stdout.write(`${pad(t.type, 7)}${t.description}\n`);
      process.stdout.write(`\nRun \`kortix artifacts types <type>\` for its format and a starter.\n`);
      return 0;
    }
  }
}
