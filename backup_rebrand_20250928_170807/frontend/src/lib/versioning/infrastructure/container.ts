import { IApiClient, IVersionRepository } from '../repositories/interfaces';
import { IVersionService, VersionService } from '../services/version-service';
import { SupabaseApiClient } from './api-client';
import { ApiVersionRepository } from './version-repository';

export class DependencyContainer {
  private static instance: DependencyContainer;
  
  private apiClient?: IApiClient;
  private versionRepository?: IVersionRepository;
  private versionService?: IVersionService;

  private constructor() {}

  static getInstance(): DependencyContainer {
    if (!DependencyContainer.instance) {
      DependencyContainer.instance = new DependencyContainer();
    }
    return DependencyContainer.instance;
  }

  getApiClient(): IApiClient {
    if (!this.apiClient) {
      this.apiClient = new SupabaseApiClient();
    }
    return this.apiClient;
  }

  getVersionRepository(): IVersionRepository {
    if (!this.versionRepository) {
      this.versionRepository = new ApiVersionRepository(this.getApiClient());
    }
    return this.versionRepository;
  }

  getVersionService(): IVersionService {
    if (!this.versionService) {
      this.versionService = new VersionService(this.getVersionRepository());
    }
    return this.versionService;
  }

  reset(): void {
    this.apiClient = undefined;
    this.versionRepository = undefined;
    this.versionService = undefined;
  }
}

export const container = DependencyContainer.getInstance(); 