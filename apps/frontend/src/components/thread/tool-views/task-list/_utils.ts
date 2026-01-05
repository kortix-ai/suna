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

/**
 * Extract task list data from structured metadata props
 * NO CONTENT PARSING - uses toolCall.arguments and toolResult.output directly
 */
export function extractTaskListData(
    argumentsData?: Record<string, any>, 
    outputData?: any
  ): TaskListData | null {
    // Try output first (from toolResult.output)
    if (outputData) {
      // Handle structured output object
      if (typeof outputData === 'object' && outputData !== null) {
        // Check for direct sections array
        if (outputData.sections && Array.isArray(outputData.sections)) {
          return { 
            sections: outputData.sections, 
            total_tasks: outputData.total_tasks, 
            total_sections: outputData.total_sections 
          };
        }
        
        // Check for nested structure
        if (outputData.output && typeof outputData.output === 'object') {
          const nested = outputData.output;
          if (nested.sections && Array.isArray(nested.sections)) {
            return { 
              sections: nested.sections, 
              total_tasks: nested.total_tasks, 
              total_sections: nested.total_sections 
            };
          }
        }
        }
      }
  
    // Try arguments as fallback (from toolCall.arguments)
    if (argumentsData && typeof argumentsData === 'object') {
      if (argumentsData.sections && Array.isArray(argumentsData.sections)) {
        return { 
          sections: argumentsData.sections, 
          total_tasks: argumentsData.total_tasks, 
          total_sections: argumentsData.total_sections 
        };
      }
      }
  
      return null;
  }