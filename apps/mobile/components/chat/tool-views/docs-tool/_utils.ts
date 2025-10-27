import type { ParsedToolData } from '@/lib/utils/tool-parser';

export interface DocMetadata {
  description?: string;
  tags?: string[];
  author?: string;
}

export interface DocumentInfo {
  id: string;
  title: string;
  filename: string;
  format: string;
  created_at: string;
  updated_at: string;
  metadata: DocMetadata;
  path: string;
  content?: string;
}

export interface DocsToolData {
  success: boolean;
  error?: string;
  message?: string;
  document?: DocumentInfo;
  documents?: DocumentInfo[];
  content?: string;
  sandbox_id?: string;
}

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

export function extractDocsData(toolData: ParsedToolData): DocsToolData {
  const { result } = toolData;
  
  let data: any = null;
  
  if (result.output) {
    const output = typeof result.output === 'string' 
      ? parseContent(result.output) 
      : result.output;
    
    data = output;
    data.success = result.success ?? true;
  } else {
    data = {
      success: result.success ?? false,
      error: 'No output data'
    };
  }
  
  if (data && data.success === undefined) {
    if (data.document || data.documents || data.message || data.content) {
      data.success = true;
    } else {
      data.success = false;
    }
  }
  
  return data;
}

export function getActionTitle(toolName: string): string {
  const name = toolName.toLowerCase().replace(/_/g, '-');
  
  if (name.includes('create')) return 'Create Document';
  if (name.includes('update') || name.includes('edit')) return 'Update Document';
  if (name.includes('read')) return 'Read Document';
  if (name.includes('delete')) return 'Delete Document';
  if (name.includes('list')) return 'List Documents';
  if (name.includes('export')) return 'Export Document';
  
  return 'Document';
}

export function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<h[1-6][^>]*>/gi, '')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

