import { describe, expect, test } from 'bun:test';

import { SANDBOX_BASE_IMAGE, kortixDefaultsSetup, kortixDefaultsTail } from '../defaults';
import {
  PLATFORM_DEFAULT_USER_DOCKERFILE,
  buildLayeredDockerfile,
  kortixWorkstationTooling,
} from '../dockerfile-layer';
import { buildMyKortixSandboxDockerfile } from '../my-kortix-dockerfile';

const ARTIFACTS = {
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  machineDocPath: 'MACHINE.md',
  slackCliPath: 'kortix-slack-cli',
  managedSkillsPath: 'managed-skills',
};

// Every image the platform builds for an agent session.
const IMAGES = [
  { label: 'platform default', dockerfile: buildLayeredDockerfile({ userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE, ...ARTIFACTS }) },
  { label: 'custom template on Debian', dockerfile: buildLayeredDockerfile({ userDockerfile: 'FROM debian:bookworm-slim\n', ...ARTIFACTS }) },
  { label: 'custom template with Docker', dockerfile: buildLayeredDockerfile({ userDockerfile: 'FROM node:22\n', containerRuntime: true, ...ARTIFACTS }) },
  { label: 'My Kortix', dockerfile: buildMyKortixSandboxDockerfile(ARTIFACTS) },
];

describe('the Kortix defaults', () => {
  for (const { label, dockerfile } of IMAGES) {
    test(`${label}: carries them verbatim, setup before tail`, () => {
      const setup = dockerfile.indexOf(kortixDefaultsSetup());
      const tail = dockerfile.indexOf(kortixDefaultsTail(ARTIFACTS));
      expect(setup).toBeGreaterThan(-1);
      expect(tail).toBeGreaterThan(setup);
      // The setup is the first Kortix step after the base image's own
      // instructions: nothing Kortix adds runs before the `kortix` user exists.
      expect(dockerfile.slice(0, setup)).not.toMatch(/^(RUN|COPY|ENV|USER)\b[^\n]*kortix/m);
    });
  }

  test('My Kortix runs on the platform default\'s base and adds no workstation', () => {
    const meta = buildMyKortixSandboxDockerfile(ARTIFACTS);
    expect(PLATFORM_DEFAULT_USER_DOCKERFILE).toContain(`FROM ${SANDBOX_BASE_IMAGE}\n`);
    expect(meta).toContain(`FROM ${SANDBOX_BASE_IMAGE}\n`);
    expect(meta).not.toContain(kortixWorkstationTooling({}));
  });

  test('a project agent\'s image is the defaults with the workstation between setup and tail', () => {
    const image = buildLayeredDockerfile({ userDockerfile: PLATFORM_DEFAULT_USER_DOCKERFILE, ...ARTIFACTS });
    const workstation = image.indexOf(kortixWorkstationTooling({}));
    expect(workstation).toBeGreaterThan(image.indexOf(kortixDefaultsSetup()));
    expect(workstation).toBeLessThan(image.indexOf(kortixDefaultsTail(ARTIFACTS)));
  });
});
