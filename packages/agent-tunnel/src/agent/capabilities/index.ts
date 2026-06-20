/**
 * Capability Registry — extensible registry for tunnel capabilities.
 *
 * Each capability (filesystem, shell, CUA-backed desktop, etc.) registers its
 * RPC method handlers here. The TunnelAgent dispatches incoming
 * JSON-RPC requests to the matching handler.
 */

export type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface Capability {
  name: string;
  methods: Map<string, RpcHandler>;
}

export class CapabilityRegistry {
  private capabilities = new Map<string, Capability>();

  register(capability: Capability): void {
    this.capabilities.set(capability.name, capability);
  }

  unregister(name: string): void {
    this.capabilities.delete(name);
  }

  getHandler(method: string): RpcHandler | null {
    for (const cap of this.capabilities.values()) {
      const handler = cap.methods.get(method);
      if (handler) return handler;
    }
    return null;
  }

  getCapabilityNames(): string[] {
    return Array.from(this.capabilities.keys());
  }

  has(name: string): boolean {
    return this.capabilities.has(name);
  }
}
