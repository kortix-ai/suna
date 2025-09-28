export interface Task {
  id: string
  content: string
  status: "pending" | "completed" | "cancelled"
  section_id: string
}

export interface Section {
  id: string
  title: string
  tasks: Task[]
}

export interface TaskListData {
  sections: Section[]
  total_tasks?: number
  total_sections?: number
  message?: string
}

export function extractTaskListData(
    assistantContent?: string, 
    toolContent?: string
  ): TaskListData | null {
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
  
    const extractFromNewFormat = (content: any): TaskListData | null => {
      const parsedContent = parseContent(content);
      
      if (!parsedContent || typeof parsedContent !== 'object') {
        return null;
      }
  
      // Check for tool_execution format
      if (parsedContent.tool_execution?.result?.output) {
        const output = parsedContent.tool_execution.result.output;
        const outputData = parseContent(output);
        
        // Nested sections format
        if (outputData?.sections && Array.isArray(outputData.sections)) {
          return { sections: outputData.sections, total_tasks: outputData.total_tasks, total_sections: outputData.total_sections };
        }
      }
  
      // Check for direct sections array
      if (parsedContent.sections && Array.isArray(parsedContent.sections)) {
        return { sections: parsedContent.sections };
      }
  
      // Check for nested content
      if (parsedContent.content) {
        return extractFromNewFormat(parsedContent.content);
      }
  
      return null;
    };


  
    // Try tool content first, then assistant content
    return extractFromNewFormat(toolContent) || extractFromNewFormat(assistantContent);
  }