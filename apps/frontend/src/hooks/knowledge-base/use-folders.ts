import { useState, useEffect } from 'react';
import { backendApi } from '@/lib/api-client';

export interface Folder {
    folder_id: string;
    name: string;
    description?: string;
    entry_count: number;
    created_at: string;
}

export interface Entry {
    entry_id: string;
    filename: string;
    summary: string;
    file_size: number;
    created_at: string;
    folder_id: string;
}

export const useKnowledgeFolders = () => {
    const [folders, setFolders] = useState<Folder[]>([]);
    const [recentFiles, setRecentFiles] = useState<Entry[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchFolders = async () => {
        try {
            // Fetch folders from backend API
            const foldersResponse = await backendApi.get<Folder[]>('/knowledge-base/folders', {
                showErrors: false,
            });

            if (foldersResponse.error) {
                console.error('Error fetching folders:', foldersResponse.error);
                setFolders([]);
            } else {
                setFolders(foldersResponse.data || []);
            }

            // Fetch recent files (last 6 files across all folders)
            // Note: This might need a separate backend endpoint, but for now we'll keep it empty
            // or fetch from entries endpoint if available
            setRecentFiles([]);
        } catch (error) {
            console.error('Failed to fetch folders:', error);
            setFolders([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchFolders();
    }, []);

    return { folders, recentFiles, loading, refetch: fetchFolders };
};
