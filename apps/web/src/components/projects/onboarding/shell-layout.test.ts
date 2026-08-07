/**
 * The redesign has exactly one structural rule: nothing renders outside a
 * single 520px decision lane.
 *
 * These assertions read the source string because the rule is about what the
 * markup is ALLOWED to contain, not about runtime state. A rendering test would
 * pass just as happily with a `max-w-2xl` container as with a `max-w-[560px]`
 * one — the defect being fixed here is invisible to the DOM API and visible
 * only in the classes.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const shell = readFileSync(join(import.meta.dir, '..', 'project-onboarding-wizard.tsx'), 'utf8');
const step = (name: string) => readFileSync(join(import.meta.dir, 'steps', name), 'utf8');

describe('onboarding shell', () => {
  test('constrains the body to one 520px decision lane', () => {
    expect(shell).toContain('max-w-[520px]');
    expect(shell).not.toContain('max-w-2xl');
  });

  test('keeps the decision lane fixed — no per-step width branch', () => {
    expect(shell).not.toContain("stepId === 'slack' ?");
  });

  test('drops the bordered footer bar in favour of an in-column primary', () => {
    expect(shell).not.toContain('StepPrimaryAction');
    expect(shell).not.toContain('border-t');
  });

  test('renders the inset panel frame only from the md breakpoint', () => {
    expect(shell).toContain('fixed inset-0');
    expect(shell).toContain('inset-0!');
    expect(shell).toContain('md:inset-2!');
    expect(shell).toContain('rounded-none!');
    expect(shell).toContain('md:rounded-md!');
    expect(shell).toContain('border-0!');
    expect(shell).toContain('md:border!');
    expect(shell).toContain('min-h-dvh!');
  });

  test('centres every step in the fixed decision lane', () => {
    expect(shell).toContain('items-center justify-center');
    expect(shell).toContain('max-w-[520px] pt-8');
    expect(shell).toContain('pb-[max(2rem,env(safe-area-inset-bottom))]');
  });

  test('binds dialog labelling to existing ids for the active step', () => {
    expect(shell).toContain('aria-labelledby={`onboarding-${stepId}-title`}');
    expect(shell).toContain('aria-describedby={`onboarding-${stepId}-description`}');
    expect(shell).not.toContain('aria-label="Project setup"');
    expect(shell).toContain('idPrefix={`onboarding-${stepId}`}');
  });

  // rounded-xl / rounded-2xl are banned on app containers by the design system.
  // The spec and plan both originally specified rounded-xl for this panel.
  test('uses no banned container radius', () => {
    expect(shell).not.toContain('rounded-xl');
    expect(shell).not.toContain('rounded-2xl');
  });

  test('derives its step list from the shared helper', () => {
    expect(shell).toContain('buildSteps(');
  });

  // Every step body lives in its own module; the shell is a frame, not a
  // grab-bag. Guards against the file drifting back into a 850-line monolith.
  test('holds no step bodies of its own', () => {
    expect(shell).not.toContain('function WelcomeStep');
    expect(shell).not.toContain('function ToolsStep');
    expect(shell).not.toContain('function SlackStep');
    expect(shell).not.toContain('function ModelStep');
  });

  // The top bar is a back control and progress. Nothing competes with the
  // question — no mark, no title, no product name.
  test('carries no branding in the chrome', () => {
    expect(shell).not.toContain('KortixAsterisk');
    expect(shell).not.toContain('Set up your project');
  });

  test('renders progress centred and a back control, nothing else', () => {
    expect(shell).toContain('<StepProgress');
    expect(shell).toContain('justify-center');
    expect(shell).toContain('aria-label="Back"');
  });

  // The welcome screen is gone, so the founder-concierge CTA has to survive
  // somewhere or the deletion silently dropped a conversion path.
  test('keeps the founder call reachable from the finish step', () => {
    expect(shell).toContain('showFounderCall');
    expect(shell).toContain('onBookCall');
  });

  test('focuses the title inside the entering step after its animation completes', () => {
    expect(shell).toContain('onAnimationComplete');
    expect(shell).toContain("querySelector<HTMLElement>('[data-onboarding-step-title]')");
    expect(shell).not.toContain("document.getElementById('onboarding-step-title')");
  });

  test('removes press scale from the back control for reduced motion', () => {
    expect(shell).toContain('motion-reduce:active:scale-100');
  });
});

describe('step shell primitive', () => {
  const stepShell = readFileSync(join(import.meta.dir, 'step-shell.tsx'), 'utf8');
  const componentSource = (name: string) => {
    const starts = [`export function ${name}`, `export const ${name}`]
      .map((declaration) => stepShell.indexOf(declaration))
      .filter((index) => index >= 0);
    const start = starts.length > 0 ? Math.min(...starts) : -1;
    if (start < 0) return '';
    const remainder = stepShell.slice(start + 1);
    const nextExportOffset = remainder.search(/\nexport (?:function|const) /);
    const end = nextExportOffset < 0 ? undefined : start + 1 + nextExportOffset;
    return stepShell.slice(start, end);
  };

  // "Question 1 of 2" told the user how much interrogation was left. The
  // progress bar already does that, more quietly.
  test('has no eyebrow prop at all', () => {
    expect(stepShell).not.toContain('eyebrow');
  });

  test('uses the selected heading and content spacing', () => {
    const shellSource = componentSource('StepShell');
    expect(shellSource).toContain('className="space-y-2"');
    expect(shellSource).toContain('{children && <div className="mt-6">');
    expect(shellSource).not.toContain('space-y-2.5');
  });

  // A skip tucked directly beneath the primary reads as a footnote to it. Side
  // by side, as a secondary, it reads as the other choice — which it is.
  test('renders skip as a lower-contrast, unequal secondary sibling', () => {
    expect(stepShell).toContain('variant="ghost"');
    expect(stepShell).not.toContain('variant="outline"');
    expect(stepShell).toContain('gap-3');
    expect(stepShell).toContain('md:justify-end');
    expect(stepShell).toContain('md:min-w-36');
    expect(stepShell).not.toContain('className="flex-1');
  });

  test('keeps mobile visual and focus order aligned', () => {
    expect(stepShell).toContain('mt-8 flex flex-col gap-3');
    expect(stepShell).not.toContain('flex-col-reverse');
  });

  test('puts real distance between the content and the actions', () => {
    expect(stepShell).toContain('mt-8');
    expect(stepShell).not.toContain('mt-10 flex items-center');
  });

  test('has no StepContext primitive or context slot', () => {
    expect(stepShell).not.toContain('StepContext');
    expect(componentSource('StepShell')).not.toContain('context');
  });

  test('exposes progress to assistive technology', () => {
    expect(stepShell).toContain('role="progressbar"');
  });

  test('gives concurrent step titles unique ids', () => {
    expect(stepShell).toContain('data-onboarding-step-title');
    expect(stepShell).not.toContain('id="onboarding-step-title"');
    expect(stepShell).toContain('id={`${idPrefix}-title`}');
    expect(stepShell).toContain('id={`${idPrefix}-description`}');
  });

  test('removes action and row press scale for reduced motion', () => {
    expect(
      componentSource('StepShell').match(/motion-reduce:active:scale-100/g) ?? [],
    ).toHaveLength(2);
    expect(stepShell.slice(0, stepShell.indexOf('export function StepProgress'))).toContain(
      'motion-reduce:active:scale-100',
    );
  });

  test('shares semantic-token, app-radius styling across both row primitives', () => {
    expect(stepShell).toContain('const rowClassName');
    expect(stepShell).toContain('rounded-md');
    expect(stepShell).toContain('bg-popover');
    expect(stepShell).toContain('border-border');
    expect(stepShell).toContain('text-foreground');
    expect(stepShell).not.toMatch(
      /(?:bg|border|text)-(?:black|white|slate|gray|zinc|neutral|stone)-/,
    );
    expect(stepShell).not.toContain('rounded-xl');
    expect(stepShell).not.toContain('rounded-2xl');
  });

  test('keeps rows 56px tall and transitions opacity explicitly', () => {
    expect(stepShell).toContain('min-h-14');
    expect(stepShell).toContain('transition-[background-color,border-color,opacity,scale]');
    expect(stepShell).not.toContain('min-h-12');
  });

  test('applies the shared row class to each row primitive', () => {
    const sharedClassApplication = /className=\{[^}]*\browClassName\b[^}]*\}/g;

    for (const component of ['SelectionRow', 'ActionRow']) {
      expect(componentSource(component).match(sharedClassApplication) ?? []).toHaveLength(1);
    }
  });
});

describe('step action copy', () => {
  test('names survey and optional skips explicitly', () => {
    expect(step('use-case-step.tsx')).toContain('skipLabel="Skip survey"');
    expect(step('company-step.tsx')).toContain('skipLabel="Skip survey"');
    expect(step('tools-step.tsx')).toContain('skipLabel="Skip for now"');
  });
});
