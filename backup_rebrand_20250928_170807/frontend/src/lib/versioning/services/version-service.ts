import { IVersionRepository } from '../repositories/interfaces';
import {
  AgentVersion,
  CreateVersionRequest,
  UpdateVersionDetailsRequest,
  VersionComparison,
  VersionDifference
} from '../types';

export interface IVersionService {
  getAllVersions(agentId: string): Promise<AgentVersion[]>;
  getVersion(agentId: string, versionId: string): Promise<AgentVersion>;
  createVersion(agentId: string, request: CreateVersionRequest): Promise<AgentVersion>;
  activateVersion(agentId: string, versionId: string): Promise<void>;
  updateVersionDetails(agentId: string, versionId: string, request: UpdateVersionDetailsRequest): Promise<AgentVersion>;
  getActiveVersion(agentId: string): Promise<AgentVersion | null>;
  getVersionByNumber(agentId: string, versionNumber: number): Promise<AgentVersion | null>;
}

export class VersionService implements IVersionService {
  constructor(private repository: IVersionRepository) {}

  async getAllVersions(agentId: string): Promise<AgentVersion[]> {
    const versions = await this.repository.getAllVersions(agentId);
    return versions.sort((a, b) => b.versionNumber.value - a.versionNumber.value);
  }

  async getVersion(agentId: string, versionId: string): Promise<AgentVersion> {
    return this.repository.getVersion(agentId, versionId);
  }

  async createVersion(
    agentId: string,
    request: CreateVersionRequest
  ): Promise<AgentVersion> {
    const newVersion = await this.repository.createVersion(agentId, request);
    return newVersion;
  }

  async activateVersion(agentId: string, versionId: string): Promise<void> {
    await this.repository.activateVersion(agentId, versionId);
  }

  async compareVersions(
    agentId: string,
    version1Id: string,
    version2Id: string
  ): Promise<VersionComparison> {
    return this.repository.compareVersions(agentId, version1Id, version2Id);
  }

  async rollbackToVersion(
    agentId: string,
    versionId: string
  ): Promise<AgentVersion> {
    const newVersion = await this.repository.rollbackToVersion(agentId, versionId);
    return newVersion;
  }

  async updateVersionDetails(
    agentId: string,
    versionId: string,
    request: UpdateVersionDetailsRequest
  ): Promise<AgentVersion> {
    const updatedVersion = await this.repository.updateVersionDetails(agentId, versionId, request);
    return updatedVersion;
  }

  async getActiveVersion(agentId: string): Promise<AgentVersion | null> {
    const versions = await this.getAllVersions(agentId);
    return versions.find(v => v.isActive) || null;
  }

  async getVersionByNumber(
    agentId: string,
    versionNumber: number
  ): Promise<AgentVersion | null> {
    const versions = await this.getAllVersions(agentId);
    return versions.find(v => v.versionNumber.value === versionNumber) || null;
  }

  calculateDifferences(v1: AgentVersion, v2: AgentVersion): VersionDifference[] {
    const differences: VersionDifference[] = [];

    if (v1.systemPrompt !== v2.systemPrompt) {
      differences.push({
        field: 'systemPrompt',
        type: 'modified',
        oldValue: v1.systemPrompt,
        newValue: v2.systemPrompt
      });
    }

    if (v1.model !== v2.model) {
      differences.push({
        field: 'model',
        type: 'modified',
        oldValue: v1.model,
        newValue: v2.model
      });
    }

    const v1Tools = new Set(Object.keys(v1.toolConfiguration.tools));
    const v2Tools = new Set(Object.keys(v2.toolConfiguration.tools));

    for (const tool of v2Tools) {
      if (!v1Tools.has(tool)) {
        differences.push({
          field: `tool.${tool}`,
          type: 'added',
          newValue: v2.toolConfiguration.tools[tool]
        });
      }
    }

    for (const tool of v1Tools) {
      if (!v2Tools.has(tool)) {
        differences.push({
          field: `tool.${tool}`,
          type: 'removed',
          oldValue: v1.toolConfiguration.tools[tool]
        });
      }
    }

    for (const tool of v1Tools) {
      if (v2Tools.has(tool) &&
          JSON.stringify(v1.toolConfiguration.tools[tool]) !== 
          JSON.stringify(v2.toolConfiguration.tools[tool])) {
        differences.push({
          field: `tool.${tool}`,
          type: 'modified',
          oldValue: v1.toolConfiguration.tools[tool],
          newValue: v2.toolConfiguration.tools[tool]
        });
      }
    }

    return differences;
  }
} 