import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const workflow = (name: string) => readFileSync(resolve(root, '.github/workflows', name), 'utf8');

describe('native platform checks use the root test system', () => {
  it('removes the standalone Rust workflow and provisions Rust in the package lane', () => {
    expect(existsSync(resolve(root, '.github/workflows/rust.yml'))).toBe(false);
    const tests = workflow('tests.yml');
    expect(tests).toContain(
      'rustup toolchain install 1.85.0 --profile minimal --component rustfmt,clippy',
    );
    expect(tests).toContain('rustup toolchain install 1.88.0 --profile minimal');
    expect(tests).toContain('cargo +1.88.0 install cargo-deny --version 0.20.2 --locked');
    expect(tests).toContain('rustup override set 1.85.0');
  });

  it('runs Swift through a matrix-selected macOS root runner lane', () => {
    const swift = workflow('kortix-swift.yml');
    expect(swift).toContain('runs-on: ${{ matrix.runner }}');
    expect(swift).toContain('runner: macos-15');
    expect(swift).toContain('run: pnpm test -- --swift-only');
    expect(swift).not.toContain('run: swift test');
    expect(swift).not.toContain('run: xcodebuild');
    expect(swift).toContain('branches: [main, staging]');
    expect(swift).not.toContain('branches: [main, staging, prod]');
    expect(swift).not.toContain('  push:');
  });
});
