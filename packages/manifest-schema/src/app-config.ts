/**
 * An `apps.<name>` block as the release config a deploy sends
 * (`@kortix/shared/app-config`). The CLI and the validator share it, so
 * `kortix validate` refuses exactly what the API would.
 *
 * The block's `command` is the image's argv and travels with the source; only
 * `processes` sets a process group's shell command.
 */
import type { AppReleaseConfigInput } from '@kortix/shared/app-config';
import type { AppBlockV2 } from './index.v2';

/** The release config fields of a block; undefined when it sets none (the server derives one). */
export function appReleaseInputFromBlock(block: AppBlockV2 | undefined): AppReleaseConfigInput | undefined {
  if (!block) return undefined;
  const input: AppReleaseConfigInput = {
    ...(block.processes ? { processes: block.processes } : {}),
    ...(block.http_service ? { http_service: block.http_service } : {}),
    ...(block.services ? { services: block.services } : {}),
    ...(block.mounts ? { mounts: block.mounts } : {}),
    ...(block.vm ? { vm: block.vm } : {}),
    ...(block.deploy ? { deploy: block.deploy } : {}),
    ...(block.port !== undefined ? { port: block.port } : {}),
    ...(block.readiness_path !== undefined ? { readiness_path: block.readiness_path } : {}),
    ...(block.always_on !== undefined ? { always_on: block.always_on } : {}),
    ...(block.resources ? { resources: block.resources } : {}),
  };
  return Object.keys(input).length > 0 ? input : undefined;
}
