import {
  DiffType,
  LineDiff,
  CharDiffPart,
  DiffStats,
  generateLineDiff,
  generateCharDiff,
  calculateDiffStats,
} from '../file-operation/_utils';

export type { DiffType, LineDiff, CharDiffPart, DiffStats };
export { generateLineDiff, generateCharDiff, calculateDiffStats };

export interface ExtractedData {
  filePath: string | null;
  oldStr: string | null;
  newStr: string | null;
  success?: boolean;
  timestamp?: string;
}


export const extractFromNewFormat = (content: any): ExtractedData => {
  if (!content) {
    return { filePath: null, oldStr: null, newStr: null };
  }

  if (typeof content === 'string') {
    // Only try to parse if it looks like JSON
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        console.debug('StrReplaceToolView: Attempting to parse JSON string:', content.substring(0, 100) + '...');
        const parsed = JSON.parse(content);
        console.debug('StrReplaceToolView: Successfully parsed JSON:', parsed);
        return extractFromNewFormat(parsed);
      } catch (error) {
        console.error('StrReplaceToolView: JSON parse error:', error, 'Content:', content.substring(0, 200));
        return { filePath: null, oldStr: null, newStr: null };
      }
    } else {
      console.debug('StrReplaceToolView: String content does not look like JSON, skipping parse');
      return { filePath: null, oldStr: null, newStr: null };
    }
  }

  if (typeof content !== 'object') {
    return { filePath: null, oldStr: null, newStr: null };
  }

  if ('tool_execution' in content && typeof content.tool_execution === 'object') {
    const toolExecution = content.tool_execution;
    const args = toolExecution.arguments || {};
    
    console.debug('StrReplaceToolView: Extracted from new format:', {
      filePath: args.file_path,
      oldStr: args.old_str ? `${args.old_str.substring(0, 50)}...` : null,
      newStr: args.new_str ? `${args.new_str.substring(0, 50)}...` : null,
      success: toolExecution.result?.success
    });
    
    return {
      filePath: args.file_path || null,
      oldStr: args.old_str || null,
      newStr: args.new_str || null,
      success: toolExecution.result?.success,
      timestamp: toolExecution.execution_details?.timestamp
    };
  }

  if ('role' in content && 'content' in content && typeof content.content === 'string') {
    console.debug('StrReplaceToolView: Found role/content structure with string content, parsing...');
    return extractFromNewFormat(content.content);
  }

  if ('role' in content && 'content' in content && typeof content.content === 'object') {
    console.debug('StrReplaceToolView: Found role/content structure with object content');
    return extractFromNewFormat(content.content);
  }

  return { filePath: null, oldStr: null, newStr: null };
};


export const extractFromLegacyFormat = (content: any, extractToolData: any, extractFilePath: any, extractStrReplaceContent: any): ExtractedData => {
  const assistantToolData = extractToolData(content);
  
  if (assistantToolData.toolResult) {
    const args = assistantToolData.arguments || {};
    
    console.debug('StrReplaceToolView: Extracted from legacy format (extractToolData):', {
      filePath: assistantToolData.filePath || args.file_path,
      oldStr: args.old_str ? `${args.old_str.substring(0, 50)}...` : null,
      newStr: args.new_str ? `${args.new_str.substring(0, 50)}...` : null
    });
    
    return {
      filePath: assistantToolData.filePath || args.file_path || null,
      oldStr: args.old_str || null,
      newStr: args.new_str || null
    };
  }

  const legacyFilePath = extractFilePath(content);
  const strReplaceContent = extractStrReplaceContent(content);
  
  console.debug('StrReplaceToolView: Extracted from legacy format (fallback):', {
    filePath: legacyFilePath,
    oldStr: strReplaceContent.oldStr ? `${strReplaceContent.oldStr.substring(0, 50)}...` : null,
    newStr: strReplaceContent.newStr ? `${strReplaceContent.newStr.substring(0, 50)}...` : null
  });
  
  return {
    filePath: legacyFilePath,
    oldStr: strReplaceContent.oldStr,
    newStr: strReplaceContent.newStr
  };
};