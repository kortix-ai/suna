import { describe, expect, test } from 'bun:test';

import { HARNESS_IDS, HARNESSES } from '@kortix/shared/harnesses';

import {
  ACP_HARNESS_CONFIG_DIRS,
  ACP_HARNESS_ICON_PROVIDER_ID,
  ACP_HARNESS_LABELS,
  ACP_HARNESSES,
  projectFilesHref,
  withAllAcpHarnesses,
} from './runtime-profile-options';

describe('withAllAcpHarnesses', () => {
  test('makes every official harness selectable without replacing custom profiles', () => {
    expect(withAllAcpHarnesses({ primary: { harness: 'opencode', config_dir: '.custom/oc' } })).toEqual({
      primary: { harness: 'opencode', config_dir: '.custom/oc' },
      claude: { harness: 'claude', config_dir: '.claude' },
      codex: { harness: 'codex', config_dir: '.codex' },
      pi: { harness: 'pi', config_dir: '.pi' },
    });
  });
});

describe('harness identity/labels/config-dirs pin the @kortix/shared descriptor', () => {
  test('ACP_HARNESSES matches HARNESS_IDS exactly, in order', () => {
    expect(ACP_HARNESSES).toEqual([...HARNESS_IDS]);
  });

  test('ACP_HARNESS_LABELS matches HARNESSES[id].label for every harness', () => {
    for (const id of HARNESS_IDS) {
      expect(ACP_HARNESS_LABELS[id], `label for ${id}`).toBe(HARNESSES[id].label);
    }
  });

  test('ACP_HARNESS_CONFIG_DIRS matches HARNESSES[id].configDir for every harness', () => {
    for (const id of HARNESS_IDS) {
      expect(ACP_HARNESS_CONFIG_DIRS[id], `configDir for ${id}`).toBe(HARNESSES[id].configDir);
    }
  });

  test('ACP_HARNESS_ICON_PROVIDER_ID declares a non-empty icon-provider id for every harness', () => {
    for (const id of HARNESS_IDS) {
      expect(typeof ACP_HARNESS_ICON_PROVIDER_ID[id], `icon provider for ${id}`).toBe('string');
      expect(ACP_HARNESS_ICON_PROVIDER_ID[id]!.length).toBeGreaterThan(0);
    }
  });
});

describe('projectFilesHref', () => {
  test('points at the standalone Files route for the project', () => {
    expect(projectFilesHref('proj_123')).toBe('/projects/proj_123/files');
  });
});
