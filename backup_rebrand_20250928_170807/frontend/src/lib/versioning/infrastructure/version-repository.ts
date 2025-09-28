import { IVersionRepository, IApiClient } from '../repositories/interfaces';
import {
  AgentVersion,
  VersionResponse,
  CreateVersionRequest,
  UpdateVersionDetailsRequest,
  VersionComparison,
} from '../types';

export class ApiVersionRepository implements IVersionRepository {
  constructor(private apiClient: IApiClient) {}
  private toAgentVersion(response: VersionResponse): AgentVersion {
    return {
      versionId: { value: response.version_id },
      agentId: { value: response.agent_id },
      versionNumber: { value: response.version_number },
      versionName: response.version_name,
      systemPrompt: response.system_prompt,
      model: response.model,
      configuredMcps: (response.configured_mcps || []).map(mcp => ({
        name: mcp.name,
        type: mcp.type || 'sse',
        config: mcp.config || {},
        enabledTools: mcp.enabledTools || mcp.enabled_tools || []
      })),
      customMcps: (response.custom_mcps || []).map(mcp => ({
        name: mcp.name,
        type: mcp.type || 'sse',
        config: mcp.config || {},
        enabledTools: mcp.enabledTools || mcp.enabled_tools || []
      })),
      toolConfiguration: {
        tools: response.agentpress_tools || {}
      },
      agentpress_tools: response.agentpress_tools || {},
      isActive: response.is_active,
      createdAt: new Date(response.created_at),
      updatedAt: new Date(response.updated_at),
      createdBy: { value: response.created_by },
      changeDescription: response.change_description
    };
  }

  async getAllVersions(agentId: string): Promise<AgentVersion[]> {
    const versions = await this.apiClient.get<VersionResponse[]>(
      `/agents/${agentId}/versions`
    );
    return versions.map(v => this.toAgentVersion(v));
  }

  async getVersion(agentId: string, versionId: string): Promise<AgentVersion> {
    const version = await this.apiClient.get<VersionResponse>(
      `/agents/${agentId}/versions/${versionId}`
    );
    return this.toAgentVersion(version);
  }

  async createVersion(
    agentId: string,
    request: CreateVersionRequest
  ): Promise<AgentVersion> {
    const version = await this.apiClient.post<VersionResponse>(
      `/agents/${agentId}/versions`,
      request
    );
    return this.toAgentVersion(version);
  }

  async activateVersion(agentId: string, versionId: string): Promise<void> {
    await this.apiClient.put(`/agents/${agentId}/versions/${versionId}/activate`);
  }

  async compareVersions(
    agentId: string,
    version1Id: string,
    version2Id: string
  ): Promise<VersionComparison> {
    const response = await this.apiClient.get<{
      version1: VersionResponse;
      version2: VersionResponse;
      differences: any[];
    }>(`/agents/${agentId}/versions/compare/${version1Id}/${version2Id}`);

    return {
      version1: this.toAgentVersion(response.version1),
      version2: this.toAgentVersion(response.version2),
      differences: response.differences
    };
  }

  async rollbackToVersion(
    agentId: string,
    versionId: string
  ): Promise<AgentVersion> {
    const version = await this.apiClient.post<VersionResponse>(
      `/agents/${agentId}/versions/${versionId}/rollback`
    );
    return this.toAgentVersion(version);
  }

  async updateVersionDetails(
    agentId: string,
    versionId: string,
    request: UpdateVersionDetailsRequest
  ): Promise<AgentVersion> {
    const version = await this.apiClient.put<VersionResponse>(
      `/agents/${agentId}/versions/${versionId}/details`,
      request
    );
    return this.toAgentVersion(version);
  }
}