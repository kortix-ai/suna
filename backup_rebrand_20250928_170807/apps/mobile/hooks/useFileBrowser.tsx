import { useOpenFileBrowser } from '@/stores/file-browser-store';

/**
 * Utility hook for opening the file browser modal
 * 
 * Usage:
 * const { openFileBrowser } = useFileBrowser();
 * 
 * // Open file browser for a specific sandbox
 * openFileBrowser('sandbox-id-123');
 * 
 * // Open file browser and navigate to a specific file/path
 * openFileBrowser('sandbox-id-123', '/workspace/src/main.py');
 */
export const useFileBrowser = () => {
    const openBrowser = useOpenFileBrowser();

    const openFileBrowser = (sandboxId: string, initialPath?: string) => {
        openBrowser(sandboxId, initialPath);
    };

    return {
        openFileBrowser,
    };
}; 