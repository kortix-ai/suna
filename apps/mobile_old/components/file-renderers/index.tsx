import { HTMLRenderer } from './HTMLRenderer';

// File extension to renderer mapping
export const rendererMap = {
    'html': HTMLRenderer,
    'htm': HTMLRenderer,
    // Add more renderers here as needed
    // 'md': MarkdownRenderer,
    // 'csv': CSVRenderer,
} as const;

// Export all renderers
export { HTMLRenderer };

// Helper function to get renderer for file extension
export function getRendererForExtension(extension: string) {
    return rendererMap[extension as keyof typeof rendererMap];
}

// Helper function to check if file type has renderer
export function hasRenderer(extension: string): boolean {
    return extension in rendererMap;
} 