import { and, eq, isNull, or } from 'drizzle-orm';
import { projectSecrets } from '@kortix/db';
import { CATALOG } from '@kortix/shared/llm-catalog';
import { OPENAI_COMPATIBLE_NPM } from '@kortix/llm-gateway';
import { db } from '../../shared/db';
import { managedModelIds } from './managed-ids';
import { CODEX_AUTH_SECRET_NAME, codexModelIds } from './codex-models';

interface GatewayModel {
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
}

const catalogNameById = new Map<string, string>();
for (const provider of CATALOG.providers) {
  for (const model of provider.models) {
    catalogNameById.set(`${provider.id}/${model.id}`, model.name);
  }
}

function humanize(id: string): string {
  const tail = id.split('/').pop() ?? id;
  return tail.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function managedModels(): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const id of managedModelIds()) {
    out[id] = {
      name: catalogNameById.get(id) ?? humanize(id),
      reasoning: true,
      tool_call: true,
      attachment: true,
      temperature: true,
    };
  }
  return out;
}

export function gatewayModelsForConnected(connectedEnvVars: Set<string>): Record<string, GatewayModel> {
  const out: Record<string, GatewayModel> = {};
  for (const provider of CATALOG.providers) {
    if (!provider.npm || !OPENAI_COMPATIBLE_NPM.has(provider.npm)) continue;
    const envVar = provider.env?.[0];
    if (!envVar || !connectedEnvVars.has(envVar)) continue;
    for (const model of provider.models) {
      out[`${provider.id}/${model.id}`] = {
        name: model.name,
        reasoning: true,
        tool_call: true,
        attachment: false,
        temperature: false,
      };
    }
  }
  return out;
}

export function gatewayCodexModels(connectedSecretNames: Set<string>): Record<string, GatewayModel> {
  if (!connectedSecretNames.has(CODEX_AUTH_SECRET_NAME)) return {};
  const out: Record<string, GatewayModel> = {};
  for (const id of codexModelIds()) {
    out[`codex/${id}`] = {
      name: `${catalogNameById.get(`openai/${id}`) ?? humanize(id)} (ChatGPT)`,
      reasoning: true,
      tool_call: true,
      attachment: false,
      temperature: false,
    };
  }
  return out;
}

async function connectedSecretNames(projectId: string, userId: string | undefined): Promise<Set<string>> {
  const ownerCondition = userId
    ? or(isNull(projectSecrets.ownerUserId), eq(projectSecrets.ownerUserId, userId))
    : isNull(projectSecrets.ownerUserId);
  const rows = await db
    .select({ name: projectSecrets.name })
    .from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), ownerCondition));
  return new Set(rows.map((row) => row.name));
}

export async function gatewayModelCatalog(
  projectId: string | undefined,
  userId: string | undefined,
): Promise<Record<string, GatewayModel>> {
  if (!projectId) return managedModels();
  const connected = await connectedSecretNames(projectId, userId);
  return {
    ...managedModels(),
    ...gatewayModelsForConnected(connected),
    ...gatewayCodexModels(connected),
  };
}
