// Error handling utilities for API operations

export const handleApiError = (error: any, context: { operation: string; resource: string }) => {
  console.error(`Error in ${context.operation} for ${context.resource}:`, error);
}; 