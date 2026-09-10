export interface PiAgentResource {
  readonly name: string;
  readonly source: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PiAgentResources {
  list(): readonly PiAgentResource[];
  readText(name: string): Promise<string>;
  readJson(name: string): Promise<unknown>;
  readBinary(name: string): Promise<Uint8Array>;
}
