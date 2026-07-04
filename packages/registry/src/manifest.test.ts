import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_OPENCODE_CONFIG_DIR,
  projectNameFromManifest,
  resolveOpencodeDir,
} from './manifest';

describe('resolveOpencodeDir — dual-format', () => {
  test('reads config_dir from a TOML [opencode] block', () => {
    expect(resolveOpencodeDir('[opencode]\nconfig_dir = "custom/oc"\n')).toBe('custom/oc');
  });

  test('reads config_dir from a YAML opencode: block', () => {
    expect(resolveOpencodeDir('opencode:\n  config_dir: custom/oc\n')).toBe('custom/oc');
    expect(resolveOpencodeDir('opencode:\n  config_dir: "quoted/oc"\n')).toBe('quoted/oc');
  });

  test('defaults when null or absent', () => {
    expect(resolveOpencodeDir(null)).toBe(DEFAULT_OPENCODE_CONFIG_DIR);
    expect(resolveOpencodeDir('project:\n  name: x\n')).toBe(DEFAULT_OPENCODE_CONFIG_DIR);
  });

  test('rejects absolute paths and traversal (both formats)', () => {
    expect(resolveOpencodeDir('opencode:\n  config_dir: /abs\n')).toBe(DEFAULT_OPENCODE_CONFIG_DIR);
    expect(resolveOpencodeDir('[opencode]\nconfig_dir = "../up"\n')).toBe(
      DEFAULT_OPENCODE_CONFIG_DIR,
    );
  });

  test('does not pick config_dir from a different section (yaml)', () => {
    const raw = 'project:\n  config_dir: nope\nopencode:\n  config_dir: apps/oc\n';
    expect(resolveOpencodeDir(raw)).toBe('apps/oc');
  });

  test('honors # comments in both formats', () => {
    expect(resolveOpencodeDir('opencode:\n  config_dir: real # trailing note\n')).toBe('real');
  });
});

describe('projectNameFromManifest — dual-format', () => {
  test('toml', () => {
    expect(projectNameFromManifest('[project]\nname = "Acme"\n')).toBe('Acme');
  });
  test('yaml', () => {
    expect(projectNameFromManifest('project:\n  name: Acme\n')).toBe('Acme');
  });
  test('null when absent', () => {
    expect(projectNameFromManifest('opencode:\n  config_dir: x\n')).toBeNull();
  });
});
