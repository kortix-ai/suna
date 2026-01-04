import { backendApi } from '../api-client';

export interface HealthCheckResponse {
  status: string;
  timestamp: string;
  instance_id: string;
}

export const checkApiHealth = async (): Promise<HealthCheckResponse> => {
  const response = await backendApi.get<HealthCheckResponse>(
    '/health',
    { showErrors: false, cache: 'no-store' }
  );

  if (response.error) {
    throw new Error(`API health check failed: ${response.error.message}`);
  }

  return response.data!;
};

