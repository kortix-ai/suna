export interface KnowledgeBaseEntry {
    source_metadata: any;
    source_type: string;
    file_size: any;
    entry_id: string;
    name: string;
    description?: string;
    content: string;
    usage_context: 'always' | 'on_request' | 'contextual';
    is_active: boolean;
    content_tokens?: number;
    created_at: string;
    updated_at: string;
  }
  
  export interface KnowledgeBaseListResponse {
    entries: KnowledgeBaseEntry[];
    total_count: number;
    total_tokens: number;
  }
  
  export interface CreateKnowledgeBaseEntryRequest {
    name: string;
    description?: string;
    content: string;
    usage_context?: 'always' | 'on_request' | 'contextual';
  }
  
  export interface UpdateKnowledgeBaseEntryRequest {
    name?: string;
    description?: string;
    content?: string;
    usage_context?: 'always' | 'on_request' | 'contextual';
    is_active?: boolean;
  }

  export interface FileUploadRequest {
    agentId: string;
    file: File;
  }

  export interface GitCloneRequest {
    agentId: string;
    git_url: string;
    branch?: string;
  }

  export interface ProcessingJob {
    job_id: string;
    job_type: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    source_info: Record<string, any>;
    result_info: Record<string, any>;
    entries_created: number;
    total_files: number;
    created_at: string;
    completed_at?: string;
    error_message?: string;
  }

  export interface ProcessingJobsResponse {
    jobs: ProcessingJob[];
  }

  export interface UploadResponse {
    job_id: string;
    message: string;
  }

  export interface CloneResponse {
    job_id: string;
    message: string;
  }