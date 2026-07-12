import { describe, expect, test } from 'bun:test';
import { withAllAcpHarnesses } from './runtime-profile-options';

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
