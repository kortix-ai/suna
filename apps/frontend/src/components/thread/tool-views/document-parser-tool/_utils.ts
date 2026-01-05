import { ToolCallData, ToolResultData } from '../types';

export interface DocumentTextContent {
  text: string;
  page: number;
}

export interface DocumentStructure {
  type: string;
  content: string;
  page: number;
}

export interface DocumentTable {
  content: string;
  page: number;
  html?: string;
}

export interface DocumentInfo {
  total_chunks: number;
  status: string;
  processing_time: string;
}

export interface DocumentSummary {
  total_pages: number;
  headings_count: number;
  text_sections: number;
  tables_count: number;
  main_headings: string[];
}

export interface DocumentParserResult {
  url: string | null;
  message: string;
  document_info: DocumentInfo;
  text_content: DocumentTextContent[];
  structure: DocumentStructure[];
  tables: DocumentTable[];
  metadata: Record<string, any>;
  summary: DocumentSummary;
  extract_tables?: boolean;
  extract_structured_data?: boolean;
}

export interface DocumentParserData {
  url: string | null;
  message: string;
  result: DocumentParserResult;
  success?: boolean;
  timestamp?: string;
}


export function extractDocumentParserData(
  toolCall: ToolCallData,
  toolResult: ToolResultData | undefined,
  isSuccess: boolean,
  toolTimestamp?: string,
  assistantTimestamp?: string
): {
  url: string | null;
  message: string;
  result: DocumentParserResult;
  actualIsSuccess: boolean;
  actualToolTimestamp?: string;
  actualAssistantTimestamp?: string;
} {
  const args = toolCall.arguments || {};
  const url = args.url || null;
  
  let message = 'Document parsed';
  let result: DocumentParserResult = {
    url,
    message: 'Document parsed',
    document_info: { total_chunks: 0, status: 'unknown', processing_time: 'N/A' },
    text_content: [],
    structure: [],
    tables: [],
    metadata: {},
    summary: { total_pages: 0, headings_count: 0, text_sections: 0, tables_count: 0, main_headings: [] },
    extract_tables: args.extract_tables,
    extract_structured_data: args.extract_structured_data
  };

  // Extract from toolResult output
  if (toolResult?.output) {
    const output = toolResult.output;
    
    if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output);
        if (parsed.content) {
          result = {
            url: parsed.url || url,
            message: parsed.message || message,
            document_info: parsed.content.document_info || result.document_info,
            text_content: parsed.content.text_content || [],
            structure: parsed.content.structure || [],
            tables: parsed.content.tables || [],
            metadata: parsed.content.metadata || {},
            summary: parsed.content.summary || result.summary,
            extract_tables: args.extract_tables,
            extract_structured_data: args.extract_structured_data
          };
          message = parsed.message || message;
        } else {
          // Direct result object
          result = {
            url: parsed.url || url,
            message: parsed.message || message,
            document_info: parsed.document_info || result.document_info,
            text_content: parsed.text_content || [],
            structure: parsed.structure || [],
            tables: parsed.tables || [],
            metadata: parsed.metadata || {},
            summary: parsed.summary || result.summary,
            extract_tables: args.extract_tables,
            extract_structured_data: args.extract_structured_data
          };
          message = parsed.message || message;
        }
      } catch (e) {
        message = output;
      }
    } else if (typeof output === 'object' && output !== null) {
      const obj = output as any;
      const content = obj.content || obj;
      
      result = {
        url: obj.url || url,
        message: obj.message || message,
        document_info: content.document_info || result.document_info,
        text_content: content.text_content || [],
        structure: content.structure || [],
        tables: content.tables || [],
        metadata: content.metadata || {},
        summary: content.summary || result.summary,
        extract_tables: args.extract_tables,
        extract_structured_data: args.extract_structured_data
      };
      message = obj.message || message;
    }
  }

  const actualIsSuccess = toolResult?.success !== undefined ? toolResult.success : isSuccess;

  return {
    url: result.url,
    message,
    result,
    actualIsSuccess,
    actualToolTimestamp: toolTimestamp,
    actualAssistantTimestamp: assistantTimestamp
  };
}