import React, { useEffect, useState } from 'react';
import { ToolResultData } from '../types';
import { useFileContentQuery, useDirectoryQuery } from '@/hooks/files/use-file-queries';
import { Editor } from '@/components/agents/docs-agent/editor';
import { createClient } from '@/lib/supabase/client';

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
  preview_url?: string;
}

export interface DocsToolData {
  success: boolean;
  error?: string;
  message?: string;
  document?: DocumentInfo;
  documents?: DocumentInfo[];
  content?: string;
  preview_url?: string;
  download_url?: string;
  export_path?: string;
  count?: number;
  sandbox_id?: string;
}

export function extractDocsData(toolResult?: ToolResultData): DocsToolData | null {
  if (!toolResult?.output) return null;
  
  try {
    let data: any = null;
    
    if (typeof toolResult.output === 'object' && toolResult.output !== null) {
      data = toolResult.output;
      if (data) {
        data.success = toolResult.success;
      }
    } else if (typeof toolResult.output === 'string') {
      try {
        const parsed = JSON.parse(toolResult.output);
        if (parsed.tool_execution?.result?.output) {
          data = parsed.tool_execution.result.output;
          if (parsed.tool_execution.result.success !== undefined) {
            data.success = parsed.tool_execution.result.success;
          }
          // Check for sandbox_id at different levels
          if (!data.sandbox_id && parsed.tool_execution?.result?.sandbox_id) {
            data.sandbox_id = parsed.tool_execution.result.sandbox_id;
          }
          if (!data.sandbox_id && parsed.sandbox_id) {
            data.sandbox_id = parsed.sandbox_id;
          }
        } else {
          data = parsed;
        }
      } catch {
        data = { content: toolResult.output, success: toolResult.success ?? true };
      }
    }
    
    if (data && data.success === undefined) {
      if (data.document || data.documents || data.message || data.content) {
        data.success = true;
      } else {
        data.success = false;
      }
    }
    return data;
  } catch (e) {
    console.error('Error parsing docs tool data:', e, toolResult);
    return { success: false, error: 'Failed to parse tool response' };
  }
}

export function extractToolName(toolCall?: { function_name?: string }): string {
  try {
    if (toolCall?.function_name) {
      return toolCall.function_name.replace(/_/g, '-').toLowerCase();
    }
  } catch (e) {
  }
  return 'docs';
}

export function extractParametersFromAssistant(assistantContent?: any) {
  try {
    if (!assistantContent) return null;
    if (typeof assistantContent === 'string' && assistantContent.includes('tool_execution')) {
      try {
        const parsed = JSON.parse(assistantContent);
        if (parsed.content) {
          const innerParsed = JSON.parse(parsed.content);
          if (innerParsed.tool_execution?.arguments) {
            return innerParsed.tool_execution.arguments;
          }
        }
      } catch {}
    }
    const toolUseMatch = assistantContent.match(/<tool_use>[\s\S]*?<\/tool_use>/);
    if (toolUseMatch) {
      const toolUseContent = toolUseMatch[0];
      const paramsMatch = toolUseContent.match(/<parameters>([\s\S]*?)<\/parameters>/);
      if (paramsMatch) {
        return JSON.parse(paramsMatch[1]);
      }
    }
    const jsonMatch = assistantContent.match(/\{[\s\S]*"content"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {}
    }
  } catch (e) {
    console.error('Error extracting parameters:', e);
  }
  return null;
}

export function extractStreamingDocumentContent(
  assistantContent?: any,
  toolName?: string
): { content?: string; title?: string; metadata?: any } | null {
  try {
    if (!assistantContent) return null;
    
    const contentStr = typeof assistantContent === 'string' 
      ? assistantContent 
      : (assistantContent.content || JSON.stringify(assistantContent));
  
    const functionCallsMatch = contentStr.match(/<function_calls>([\s\S]*?)<\/function_calls>/);
    if (functionCallsMatch) {
      const functionContent = functionCallsMatch[1];

      const invokeMatch = functionContent.match(/<invoke[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/invoke>|$)/);
      if (invokeMatch) {
        const invokeName = invokeMatch[1];
        const invokeContent = invokeMatch[2];
        
        if (invokeName === 'create_document' || invokeName === 'update_document' || 
            invokeName === 'edit_file' || toolName?.includes('create') || toolName?.includes('update')) {
          
          const result: { content?: string; title?: string; metadata?: any } = {};
          

          const titleMatch = invokeContent.match(/<parameter[^>]*name=["']title["'][^>]*>([\s\S]*?)(?:<\/parameter>|$)/);
          if (titleMatch) {
            result.title = titleMatch[1].trim();
          }
          

          const contentMatch = invokeContent.match(/<parameter[^>]*name=["'](?:content|file_contents)["'][^>]*>([\s\S]*?)(?:<\/parameter>|$)/);
          if (contentMatch) {
            result.content = contentMatch[1];
          }
          

          const metadataMatch = invokeContent.match(/<parameter[^>]*name=["']metadata["'][^>]*>([\s\S]*?)(?:<\/parameter>|$)/);
          if (metadataMatch) {
            try {
              result.metadata = JSON.parse(metadataMatch[1]);
            } catch {
              result.metadata = metadataMatch[1];
            }
          }
          
          return result;
        }
      }
    }
    

    const createDocMatch = contentStr.match(/<create-document[^>]*>([\s\S]*?)(?:<\/create-document>|$)/);
    if (createDocMatch) {
      const docContent = createDocMatch[1];
      const result: { content?: string; title?: string; metadata?: any } = {};
      

      const titleAttrMatch = contentStr.match(/<create-document[^>]*title=["']([^"']+)["']/);
      if (titleAttrMatch) {
        result.title = titleAttrMatch[1];
      }
      
      // Content is the inner text
      if (docContent) {
        result.content = docContent;
      }
      
      return result;
    }
    
    // Try to extract from parameters in assistant content
    const params = extractParametersFromAssistant(assistantContent);
    if (params && (params.content || params.title)) {
      return {
        content: params.content,
        title: params.title,
        metadata: params.metadata
      };
    }
    
  } catch (e) {
    console.error('Error extracting streaming document content:', e);
  }
  
  return null;
}

export function getActionTitle(toolName: string): string {
  const normalizedName = toolName.replace(/-/g, '_');
  switch (normalizedName) {
    case 'create_document': return 'Document Created';
    case 'update_document': return 'Document Updated';
    case 'read_document': return 'Document Retrieved';
    case 'list_documents': return 'Documents Listed';
    case 'delete_document': return 'Document Deleted';
    case 'export_document': return 'Document Exported';
    case 'get_tiptap_format_guide': return 'Format Guide';
    default: return 'Document Operation';
  }
}

export function LiveDocumentViewer({ 
  path, 
  sandboxId, 
  format,
  fallbackContent 
}: { 
  path?: string; 
  sandboxId?: string; 
  format: string;
  fallbackContent?: string;
}) {
  const { data: fileContent, isLoading, error, refetch } = useFileContentQuery(
    sandboxId || '',
    path || '',
    {
      enabled: Boolean(sandboxId && path),
      contentType: 'text',
      staleTime: 1000,
    }
  );

  React.useEffect(() => {
    if (sandboxId && path) {
      const interval = setInterval(() => {
        refetch();
      }, 5000);
      
      return () => clearInterval(interval);
    }
  }, [sandboxId, path, refetch]);

  let content = fileContent || fallbackContent || '';
  
  if (typeof content === 'string' && (format === 'doc' || format === 'tiptap')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.type === 'tiptap_document' && parsed.content) {
        content = parsed.content;
      }
    } catch {
    }
  }

  if (isLoading && !content) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-sm text-muted-foreground">Loading document...</div>
      </div>
    );
  }

  if (error && !content) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-sm text-rose-500">Failed to load document</div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-sm text-muted-foreground">No content available</div>
      </div>
    );
  }

  return <DocumentViewer content={content} format={format} />;
}

export function DocumentViewer({ content, format }: { content: string; format: string }) {
  if (format === 'doc' || format === 'tiptap') {
    let htmlContent = content;
    try {
      const parsed = typeof content === 'string' ? JSON.parse(content) : content;
      if (parsed.type === 'tiptap_document' && parsed.content) {
        htmlContent = parsed.content;
      }
    } catch {
    }
    
    return (
      <div className="w-full">
        <Editor 
          content={htmlContent}
          readOnly={true}
          useStore={false}
          showWordCount={false}
          autoSave={false}
          minHeight="0"
          className="w-full"
          editorClassName="focus:outline-none bg-transparent border-0 w-full prose prose-sm dark:prose-invert max-w-none prose-img:max-w-none prose-img:w-full prose-img:h-auto"
        />
      </div>
    );
  }
  
  if (format === 'html') {
    return (
      <div className="w-full">
        <Editor 
          content={content}
          readOnly={true}
          useStore={false}
          showWordCount={false}
          autoSave={false}
          minHeight="0"
          className="w-full"
          editorClassName="focus:outline-none bg-transparent border-0 w-full prose prose-sm dark:prose-invert max-w-none prose-img:max-w-none prose-img:w-full prose-img:h-auto"
        />
      </div>
    );
  }
  
  if (format === 'markdown') {
    return (
      <pre className="whitespace-pre-wrap font-mono text-sm">
        {content}
      </pre>
    );
  }
  
  if (format === 'json') {
    try {
      const parsed = JSON.parse(content);
      return (
        <pre className="whitespace-pre-wrap font-mono text-sm">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {
      return (
        <pre className="whitespace-pre-wrap font-mono text-sm">
          {content}
        </pre>
      );
    }
  }
  
  return (
    <div className="whitespace-pre-wrap text-sm">
      {content}
    </div>
  );
} 