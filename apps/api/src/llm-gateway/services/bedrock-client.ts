// Thin wrapper around the AWS Bedrock Runtime SDK. Isolated here so the rest of
// the gateway never imports the SDK directly (keeps bedrock-translate.ts pure
// and unit-testable). The client is created lazily and memoized per-region so a
// gateway with Bedrock disabled never instantiates the SDK.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { ConverseRequest } from './bedrock-translate';

export interface BedrockClientConfig {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

const clients = new Map<string, BedrockRuntimeClient>();

function getClient(cfg: BedrockClientConfig): BedrockRuntimeClient {
  const cacheKey = `${cfg.region}:${cfg.accessKeyId ?? 'default'}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = new BedrockRuntimeClient({
      region: cfg.region,
      // When no explicit keys are provided, the SDK's default credential chain
      // (env vars, IRSA / instance role on EKS, etc.) is used — which is the
      // production path on our EKS nodes.
      ...(cfg.accessKeyId && cfg.secretAccessKey
        ? {
            credentials: {
              accessKeyId: cfg.accessKeyId,
              secretAccessKey: cfg.secretAccessKey,
              sessionToken: cfg.sessionToken,
            },
          }
        : {}),
    });
    clients.set(cacheKey, client);
  }
  return client;
}

// Senders are swappable so tests can inject a fake without the AWS SDK doing I/O.
export type ConverseSender = (cfg: BedrockClientConfig, req: ConverseRequest) => Promise<any>;

let converseSender: ConverseSender = (cfg, req) =>
  getClient(cfg).send(new ConverseCommand(req as any));

let converseStreamSender: ConverseSender = (cfg, req) =>
  getClient(cfg).send(new ConverseStreamCommand(req as any));

export function bedrockConverse(cfg: BedrockClientConfig, req: ConverseRequest): Promise<any> {
  return converseSender(cfg, req);
}

export function bedrockConverseStream(cfg: BedrockClientConfig, req: ConverseRequest): Promise<any> {
  return converseStreamSender(cfg, req);
}

/** Test seam — override the underlying senders; returns a restore fn. */
export function __setSenders(overrides: {
  converse?: ConverseSender;
  converseStream?: ConverseSender;
}): () => void {
  const prevConverse = converseSender;
  const prevStream = converseStreamSender;
  if (overrides.converse) converseSender = overrides.converse;
  if (overrides.converseStream) converseStreamSender = overrides.converseStream;
  return () => {
    converseSender = prevConverse;
    converseStreamSender = prevStream;
  };
}
