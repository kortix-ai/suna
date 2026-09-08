import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

const sessionChat = source('../session-chat.tsx');
const instantSessionShell = source('../instant-session-shell.tsx');
const sessionLayout = source('../session-layout.tsx');
const sessionPanelProvider = source('../action-panel/session-panel-provider.tsx');
const projectHome = source('../../workspace/project-layout/project-home.tsx');
const projectIndexPage = source('../../../app/(app)/projects/[id]/page.tsx');
const projectSessionPage = source('../../../app/(app)/projects/[id]/sessions/[sessionId]/page.tsx');

describe('existing project session composer runtime contract', () => {
  test('locks compiled selectors and gates attachments on the running worker capability', () => {
    expect(sessionChat).toContain(
      'onAgentChange={runtimePromptOverridesAllowed ? handleAgentChange : undefined}',
    );
    expect(sessionChat).toContain('agentSelectorLocked={!runtimePromptOverridesAllowed}');
    expect(sessionChat).toContain(
      'onModelChange={runtimePromptOverridesAllowed ? handleModelChange : undefined}',
    );
    expect(sessionChat).toContain(
      'onVariantChange={runtimeReasoningAllowed ? handleVariantChange : undefined}',
    );
    expect(sessionChat).toContain('attachmentsEnabled={runtimeAttachmentsAllowed}');
    expect(sessionChat).toContain('local.model.imageAttachmentsSupported === true');
    expect(sessionChat).toContain('putSessionImage(projectId!, projectSessionId!');
  });

  test('strips stale prompt overrides and refuses file parts before upload', () => {
    const optionsStart = sessionChat.indexOf(
      'const options: Record<string, unknown> = resolveRuntimePromptOverrides({',
    );
    const partsStart = sessionChat.indexOf('// Build parts: text first', optionsStart);
    const optionsBlock = sessionChat.slice(optionsStart, partsStart);

    expect(optionsBlock).toContain('agentEnabled: runtimePromptOverridesAllowed');
    expect(optionsBlock).toContain('modelEnabled: runtimePromptOverridesAllowed');
    expect(optionsBlock).toContain('variantEnabled: runtimeReasoningAllowed');
    expect(sessionChat.indexOf('const fileError = runtimePromptFilesError({')).toBeLessThan(
      partsStart,
    );
  });

  test('propagates the live sandbox Pi signal to every attachment entry point', () => {
    expect(projectSessionPage).toContain(
      'sandboxIsPiWorker={isPiWorkerRuntimeMetadata(sessionState.sandbox?.metadata)}',
    );
    expect(sessionLayout).toContain('sandboxIsPiWorker={sandboxIsPiWorker}');
    expect(sessionPanelProvider).toContain('sandboxIsPiWorker = false');
    expect(sessionPanelProvider).toContain('sandboxIsPiWorker,');
  });

  test('strips stale overrides when retrying a legacy pending prompt', () => {
    expect(projectSessionPage).toContain(
      'const runtimePromptOverridesAllowed = runtimePromptOverridesEnabled({',
    );
    expect(projectSessionPage).toContain(
      'overrides: resolveRuntimePromptOverrides({\n          agentEnabled: runtimePromptOverridesAllowed,',
    );
    expect(projectSessionPage).toContain('modelEnabled: runtimePromptOverridesAllowed');
    expect(projectSessionPage).toContain('variantEnabled: runtimePromptOverridesAllowed');
  });
});

describe('new project session composer runtime contract', () => {
  test('keeps creation agent selection but hides unsafe first-prompt controls', () => {
    expect(projectHome).toContain('modelOverridesEnabled={modelOverridesEnabled}');
    expect(projectHome).toContain('attachmentsEnabled={modelOverridesEnabled}');
    expect(projectHome).not.toContain('agentOverridesEnabled={modelOverridesEnabled}');
  });

  test('keeps the compiled agent but removes unsafe first-prompt fields at the create boundary', () => {
    expect(projectIndexPage).toContain('attachmentsEnabled: runtimePromptOverridesAllowed');
    expect(projectIndexPage).toContain('const promptOverrides = resolveRuntimePromptOverrides({');
    expect(projectIndexPage).toContain('agentEnabled: true');
    expect(projectIndexPage).toContain('modelEnabled: runtimePromptOverridesAllowed');
    expect(projectIndexPage).toContain('variantEnabled: runtimePromptOverridesAllowed');
    expect(projectIndexPage).toContain('agent: promptOverrides.agent ?? null');
    expect(projectIndexPage).toContain('model: promptOverrides.model ?? null');
    expect(projectIndexPage).toContain('variant: promptOverrides.variant ?? null');
  });
});

describe('instant session composer runtime contract', () => {
  test('locks all unsupported controls while runtime identity is unknown or Pi', () => {
    expect(instantSessionShell).toContain('modelOverridesEnabled={runtimePromptOverridesAllowed}');
    expect(instantSessionShell).toContain('agentOverridesEnabled={runtimePromptOverridesAllowed}');
    expect(instantSessionShell).toContain('attachmentsEnabled={runtimePromptOverridesAllowed}');
    expect(instantSessionShell).toContain(
      'sandboxIsPiWorker={isPiWorkerRuntimeMetadata(projectSessionRow?.metadata)}',
    );
  });

  test('sends only resolved runtime overrides and rejects stale files', () => {
    expect(instantSessionShell).toContain(
      'const promptOverrides = resolveRuntimePromptOverrides({',
    );
    expect(instantSessionShell).toContain('overrides: promptOverrides');
    expect(instantSessionShell).toContain('const fileError = runtimePromptFilesError({');
  });
});
