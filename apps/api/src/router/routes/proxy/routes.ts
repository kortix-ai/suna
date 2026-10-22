import { proxy, services } from './app';
import { handleProxy } from './handlers';

export function registerProxyRoutes(): void {
  for (const [prefix, serviceConfig] of Object.entries(services)) {
    proxy.all(`/${prefix}/*`, (c) => handleProxy(c, serviceConfig, prefix));
    proxy.all(`/${prefix}`, (c) => handleProxy(c, serviceConfig, prefix));
  }
}
