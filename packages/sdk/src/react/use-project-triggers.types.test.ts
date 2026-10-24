/**
 * Type-level contract of the trigger fire surface. `pnpm --filter @kortix/sdk
 * typecheck` checks the body; `bun test` only proves the file loads.
 */
import { expect, test } from 'bun:test';
import type { bindProjectOperationsAdmin } from '../core/client/project-operations-admin';
import type { ProjectSpaceSummary } from '../core/rest/projects-client/spaces';
import type {
  CreateProjectTriggerInput,
  FireProjectTriggerResponse,
  ProjectTrigger,
  UpdateProjectTriggerInput,
  ProjectTriggerDryRunResult,
  fireProjectTrigger,
} from '../core/rest/projects-client/triggers';
import type { useProjectTriggers } from './use-project-triggers';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function expectTrue<T extends true>(): void;
declare const fire: typeof fireProjectTrigger;
declare const handleFire: ReturnType<typeof bindProjectOperationsAdmin>['triggers']['fire'];
type Hook = ReturnType<typeof useProjectTriggers>;

/** Never called: the body is checked by `tsc`. */
export function fireTypes(flag: boolean): void {
  // A host reads `res.status` off `fire` (mobile SchedulesPage): `fire` never returns a dry-run result.
  expectTrue<Equal<Hook['fire']['data'], FireProjectTriggerResponse | undefined>>();
  expectTrue<Equal<Hook['dryRun']['data'], ProjectTriggerDryRunResult | undefined>>();

  const plain = () => fire('p', 's');
  const withPayload = () => fire('p', 's', { payload: {} });
  const literalDry = () => fire('p', 's', { dryRun: true });
  const literalFalse = () => fire('p', 's', { dryRun: false });
  const unknownDry = () => fire('p', 's', { dryRun: flag });
  expectTrue<Equal<Awaited<ReturnType<typeof plain>>, FireProjectTriggerResponse>>();
  expectTrue<Equal<Awaited<ReturnType<typeof withPayload>>, FireProjectTriggerResponse>>();
  expectTrue<Equal<Awaited<ReturnType<typeof literalDry>>, ProjectTriggerDryRunResult>>();
  expectTrue<Equal<Awaited<ReturnType<typeof literalFalse>>, FireProjectTriggerResponse>>();
  expectTrue<Equal<Awaited<ReturnType<typeof unknownDry>>, FireProjectTriggerResponse | ProjectTriggerDryRunResult>>();

  const handlePlain = () => handleFire('s');
  const handleDry = () => handleFire('s', { dryRun: true });
  const handleUnknown = () => handleFire('s', { dryRun: flag });
  expectTrue<Equal<Awaited<ReturnType<typeof handlePlain>>, FireProjectTriggerResponse>>();
  expectTrue<Equal<Awaited<ReturnType<typeof handleDry>>, ProjectTriggerDryRunResult>>();
  expectTrue<Equal<Awaited<ReturnType<typeof handleUnknown>>, FireProjectTriggerResponse | ProjectTriggerDryRunResult>>();
}

/** Never called: a trigger names the channel or DM its runs post to, and a space counts its triggers. */
export function spaceTypes(): void {
  expectTrue<Equal<ProjectTrigger['space_id'], string | null | undefined>>();
  expectTrue<Equal<CreateProjectTriggerInput['space_id'], string | null | undefined>>();
  expectTrue<Equal<UpdateProjectTriggerInput['space_id'], string | null | undefined>>();
  expectTrue<Equal<ProjectSpaceSummary['triggers'], number>>();
}

test('the space type contract compiles (checked by typecheck)', () => {
  expect(typeof spaceTypes).toBe('function');
});

test('the fire type contract compiles (checked by typecheck)', () => {
  expect(typeof fireTypes).toBe('function');
});
