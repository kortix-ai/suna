import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const translations = JSON.parse(
  readFileSync(new URL('../../../translations/en.json', import.meta.url), 'utf8'),
) as {
  hardcodedUi: {
    appHomePage: Record<string, string>;
  };
};

const cliDemoSource = readFileSync(
  new URL('../../components/home/cli-demo.tsx', import.meta.url),
  'utf8',
);

const iconSource = readFileSync(new URL('../icon/icon.tsx', import.meta.url), 'utf8');

const securitySource = readFileSync(new URL('./security/security.tsx', import.meta.url), 'utf8');

describe('landing product communication', () => {
  test('states the Git ownership, ACP harness, and shared SDK contract', () => {
    const home = translations.hardcodedUi.appHomePage;

    expect(home.heroEyebrow).toBe('One Git-owned project · Four ACP harnesses');
    expect(home.heroCommandCenter).toBe('Run one agent project through four ACP harnesses.');
    expect(home.heroAiWorkforce).toBe('OpenCode, Claude Code, Codex, and Pi. One project you own.');
    expect(home.heroDescription).toBe(
      'Agents, skills, connectors, and policies live in versioned Git. The shared Kortix SDK powers the web app and reference apps, so the same ACP session layer can serve other platforms.',
    );
  });

  test('lists the four shipped harnesses without Cursor or an OpenCode-only claim', () => {
    expect(cliDemoSource).toContain("const AGENTS = ['OpenCode', 'Claude Code', 'Codex', 'Pi'];");
    expect(cliDemoSource).toContain('This Git-owned project includes four ACP profiles:');
    expect(cliDemoSource).toContain('One Kortix SDK session contract powers web');
    expect(cliDemoSource).not.toContain(
      "const AGENTS = ['opencode', 'claude', 'codex', 'cursor'];",
    );
    expect(cliDemoSource).not.toContain(
      'The starter includes an OpenCode harness profile by default.',
    );
  });

  test('uses React SVG attributes and shader-compatible landing colors', () => {
    expect(iconSource).not.toContain('stop-color');
    expect(iconSource).not.toContain('stop-opacity');
    expect(securitySource).not.toContain("colors={['var(--kortix-orange)'");
    expect(securitySource).toContain("'#d18b19'");
  });
});
