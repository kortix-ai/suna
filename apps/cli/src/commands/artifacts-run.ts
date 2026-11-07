// The shared shape of the `kortix artifacts` handlers: the parsed flags and
// the project, resolver and printers `runArtifacts` builds once per run.
import type { Artifact, ArtifactVisibility } from '@kortix/sdk';
import type { ApiClient } from '../api/client.ts';

export interface ArtifactsFlags {
  json: boolean; projectArg?: string; hostArg?: string; type?: string; title?: string; description?: string;
  visibility?: string; id?: string; baseVersion?: string; version?: string; search?: string;
  with: string[]; mine: boolean; shared: boolean; pinned: boolean; starter: boolean;
  space?: string; agent?: string; clear: boolean;
}

export interface ArtifactsRun {
  pid: string;
  client: ApiClient;
  f: ArtifactsFlags;
  a0: string | undefined;
  a1: string | undefined;
  meta: { title?: string; description?: string; visibility?: ArtifactVisibility; space?: string; agent?: string };
  resolve: (ref: string | undefined) => Promise<string | null>;
  out: (payload: unknown, line: string) => number;
  shared: (a: Artifact, verb: string) => number;
}

export const TYPES = ['doc', 'html'];
export const short = (id: string) => id.slice(0, 8);
