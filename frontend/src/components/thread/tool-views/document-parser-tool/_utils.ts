import { extractToolData } from '../utils';

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

const extractFromNewFormat = (content: any): DocumentParserData => {
  const parsedContent = parseContent(content);
  
  if (!parsedContent || typeof parsedContent !== 'object') {
    return { 
      url: null, 
      message: 'No data available',
      result: {
        url: null,
        message: 'No data available',
        document_info: { total_chunks: 0, status: 'unknown', processing_time: 'N/A' },
        text_content: [],
        structure: [],
        tables: [],
        metadata: {},
        summary: { total_pages: 0, headings_count: 0, text_sections: 0, tables_count: 0, main_headings: [] }
      },
      success: undefined, 
      timestamp: undefined 
    };
  }

  if ('tool_execution' in parsedContent && typeof parsedContent.tool_execution === 'object') {
    const toolExecution = parsedContent.tool_execution;
    const args = toolExecution.arguments || {};
    
    let parsedOutput = toolExecution.result?.output;
    if (typeof parsedOutput === 'string') {
      try {
        parsedOutput = JSON.parse(parsedOutput);
      } catch (e) {
      }
    }
    parsedOutput = parsedOutput || {};

    const content = parsedOutput?.content || {};

    const extractedData: DocumentParserData = {
      url: args.url || null,
      message: parsedOutput?.message || 'Document parsed',
      result: {
        url: args.url || null,
        message: parsedOutput?.message || 'Document parsed',
        document_info: content.document_info || { total_chunks: 0, status: 'unknown', processing_time: 'N/A' },
        text_content: content.text_content || [],
        structure: content.structure || [],
        tables: content.tables || [],
        metadata: content.metadata || {},
        summary: content.summary || { total_pages: 0, headings_count: 0, text_sections: 0, tables_count: 0, main_headings: [] },
        extract_tables: args.extract_tables,
        extract_structured_data: args.extract_structured_data
      },
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
    return extractedData;
  }

  if ('message' in parsedContent && 'content' in parsedContent) {
    const content = parsedContent.content || {};
    return {
      url: null,
      message: parsedContent.message || 'Document parsed',
      result: {
        url: null,
        message: parsedContent.message || 'Document parsed',
        document_info: content.document_info || { total_chunks: 0, status: 'unknown', processing_time: 'N/A' },
        text_content: content.text_content || [],
        structure: content.structure || [],
        tables: content.tables || [],
        metadata: content.metadata || {},
        summary: content.summary || { total_pages: 0, headings_count: 0, text_sections: 0, tables_count: 0, main_headings: [] }
      },
      success: true,
      timestamp: undefined
    };
  }

  if ('role' in parsedContent && 'content' in parsedContent) {
    return extractFromNewFormat(parsedContent.content);
  }

  return { 
    url: null, 
    message: 'No data available',
    result: {
      url: null,
      message: 'No data available',
      document_info: { total_chunks: 0, status: 'unknown', processing_time: 'N/A' },
      text_content: [],
      structure: [],
      tables: [],
      metadata: {},
      summary: { total_pages: 0, headings_count: 0, text_sections: 0, tables_count: 0, main_headings: [] }
    },
    success: undefined, 
    timestamp: undefined 
  };
};

const extractFromLegacyFormat = (content: any): Omit<DocumentParserData, 'success' | 'timestamp'> => {
  const toolData = extractToolData(content);
  
  if (toolData.toolResult) {
    const args = toolData.arguments || {};
    const resultMessage = typeof toolData.toolResult === 'string' ? toolData.toolResult : 'Document parsing attempted';
    return {
      url: args.url || null,
      message: resultMessage,
      result: {
        url: args.url || null,
        message: resultMessage,
        document_info: { total_chunks: 0, status: 'unknown', processing_time: 'N/A' },
        text_content: [],
        structure: [],
        tables: [],
        metadata: {},
        summary: { total_pages: 0, headings_count: 0, text_sections: 0, tables_count: 0, main_headings: [] },
        extract_tables: args.extract_tables,
        extract_structured_data: args.extract_structured_data
      }
    };
  }

  return {
    url: null,
    message: 'No data available',
    result: {
      url: null,
      message: 'No data available',
      document_info: { total_chunks: 0, status: 'unknown', processing_time: 'N/A' },
      text_content: [],
      structure: [],
      tables: [],
      metadata: {},
      summary: { total_pages: 0, headings_count: 0, text_sections: 0, tables_count: 0, main_headings: [] }
    }
  };
};

export function extractDocumentParserData(
  assistantContent: any,
  toolContent: any,
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
  let data: DocumentParserData = {
    url: null,
    message: 'No data available',
    result: {
      url: null,
      message: 'No data available',
      document_info: { total_chunks: 0, status: 'unknown', processing_time: 'N/A' },
      text_content: [],
      structure: [],
      tables: [],
      metadata: {},
      summary: { total_pages: 0, headings_count: 0, text_sections: 0, tables_count: 0, main_headings: [] }
    }
  };
  let actualIsSuccess = isSuccess;
  let actualToolTimestamp = toolTimestamp;
  let actualAssistantTimestamp = assistantTimestamp;

  const assistantNewFormat = extractFromNewFormat(assistantContent);
  const toolNewFormat = extractFromNewFormat(toolContent);

  if (assistantNewFormat.url || assistantNewFormat.result.text_content.length > 0) {
    data = assistantNewFormat;
    if (assistantNewFormat.success !== undefined) {
      actualIsSuccess = assistantNewFormat.success;
    }
    if (assistantNewFormat.timestamp) {
      actualAssistantTimestamp = assistantNewFormat.timestamp;
    }
  } else if (toolNewFormat.url || toolNewFormat.result.text_content.length > 0) {
    data = toolNewFormat;
    if (toolNewFormat.success !== undefined) {
      actualIsSuccess = toolNewFormat.success;
    }
    if (toolNewFormat.timestamp) {
      actualToolTimestamp = toolNewFormat.timestamp;
    }
  } else {
    const assistantLegacy = extractFromLegacyFormat(assistantContent);
    const toolLegacy = extractFromLegacyFormat(toolContent);

    data = {
      ...assistantLegacy,
      ...toolLegacy,
      url: assistantLegacy.url || toolLegacy.url,
      success: undefined,
      timestamp: undefined
    };
  }

  return {
    url: data.url,
    message: data.message,
    result: data.result,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  };
}