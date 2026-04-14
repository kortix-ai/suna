import { Zap, Globe, Database, Shield } from "lucide-react";

export const AVAILABLE_SERVICES = [
  { id: 'agent-runner', label: 'Agent Runner', icon: Zap },
  { id: 'web-application', label: 'Web Application', icon: Globe },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'authentication', label: 'Authentication', icon: Shield },
] as const;

export type ServiceId = typeof AVAILABLE_SERVICES[number]['id'];
export type ServiceLabel = typeof AVAILABLE_SERVICES[number]['label'];
