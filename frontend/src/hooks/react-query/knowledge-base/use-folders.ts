import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

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
            const supabase = createClient();

            // Fetch folders directly using Supabase client with RLS
            const { data: foldersData, error: foldersError } = await supabase
                .from('knowledge_base_folders')
                .select('folder_id, name, description, created_at')
                .order('created_at', { ascending: false });

            if (foldersError) {
                console.error('Supabase error fetching folders:', foldersError);
                return;
            }

            // Fetch recent files (last 6 files across all folders)
            const { data: recentFilesData, error: recentError } = await supabase
                .from('knowledge_base_entries')
                .select('entry_id, filename, summary, file_size, created_at, folder_id')
                .order('created_at', { ascending: false })
                .limit(6);

            if (recentError) {
                console.error('Supabase error fetching recent files:', recentError);
            } else {
                setRecentFiles(recentFilesData || []);
            }

            // Get entry counts for each folder
            const foldersWithCounts = await Promise.all(
                foldersData.map(async (folder) => {
                    const { count, error: countError } = await supabase
                        .from('knowledge_base_entries')
                        .select('*', { count: 'exact', head: true })
                        .eq('folder_id', folder.folder_id);

                    if (countError) {
                        console.error('Error counting entries:', countError);
                    }

                    return {
                        folder_id: folder.folder_id,
                        name: folder.name,
                        description: folder.description,
                        entry_count: count || 0,
                        created_at: folder.created_at
                    };
                })
            );

            setFolders(foldersWithCounts);
        } catch (error) {
            console.error('Failed to fetch folders:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchFolders();
    }, []);

    return { folders, recentFiles, loading, refetch: fetchFolders };
};
