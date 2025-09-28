import {
  AgentVersion,
  VersionResponse,
  CreateVersionRequest,
  UpdateVersionDetailsRequest,
  VersionComparison
} from '../types';

export interface IVersionRepository {
  getAllVersions(agentId: string): Promise<AgentVersion[]>;
  getVersion(agentId: string, versionId: string): Promise<AgentVersion>;
  createVersion(agentId: string, request: CreateVersionRequest): Promise<AgentVersion>;
  activateVersion(agentId: string, versionId: string): Promise<void>;
  compareVersions(agentId: string, version1Id: string, version2Id: string): Promise<VersionComparison>;
  rollbackToVersion(agentId: string, versionId: string): Promise<AgentVersion>;
  updateVersionDetails(agentId: string, versionId: string, request: UpdateVersionDetailsRequest): Promise<AgentVersion>;
}

export interface IApiClient {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, data?: any): Promise<T>;
  put<T>(url: string, data?: any): Promise<T>;
  delete(url: string): Promise<void>;
} 