export interface MonitoringConfig {
  clusterName: string;
  deploymentName: string;
  namespace: string;
  environment: string;
  cpuThresholdWarning: number;
  cpuThresholdCritical: number;
  memoryThresholdWarning: number;
  memoryThresholdCritical: number;
  alertEmails: string[];
  tags?: Record<string, string>;
}
