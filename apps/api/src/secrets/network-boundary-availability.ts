import { config } from '../config';

export function networkBoundaryDeliveryAvailable(): boolean {
  return config.isPlatinumEnabled();
}
