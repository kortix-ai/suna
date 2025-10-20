import { Project } from '@/api/project-api';
import React, { createContext, ReactNode, useContext, useState } from 'react';

// Temporary project for new chat mode
const NEW_CHAT_PROJECT: Project = {
    id: 'new-chat-temp',
    name: 'New Chat',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: 'Temporary project for new chat',
    account_id: '',
    sandbox: {},
};

interface ChatContextType {
    selectedProject: Project | null;
    setSelectedProject: (project: Project | null) => void;
    clearSelection: () => void;
    isNewChatMode: boolean;
    setNewChatMode: (enabled: boolean) => void;
    updateNewChatProject: (projectData: Partial<Project>) => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

interface ChatProviderProps {
    children: ReactNode;
}

export const ChatProvider: React.FC<ChatProviderProps> = ({ children }) => {
    const [selectedProject, setSelectedProject] = useState<Project | null>(null); // Start with no project
    const [isNewChatMode, setIsNewChatMode] = useState(true); // Default to new chat

    const clearSelection = () => {
        setSelectedProject(null); // No project selected
        setIsNewChatMode(true);
    };

    const setNewChatMode = (enabled: boolean) => {
        setIsNewChatMode(enabled);
        if (enabled) {
            setSelectedProject(null); // Clear project when starting new chat mode
        }
    };

    const updateNewChatProject = (projectData: Partial<Project>) => {
        if (isNewChatMode) {
            // Create or update the project
            const updatedProject: Project = {
                id: 'new-chat-temp',
                name: 'New Chat',
                description: 'Temporary project for new chat',
                account_id: '',
                sandbox: {},
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                ...projectData, // Override with provided data
            };

            console.log('[ChatContext] Updating project:', updatedProject);
            setSelectedProject(updatedProject);
        }
    };

    const value: ChatContextType = {
        selectedProject,
        setSelectedProject: (project) => {
            setSelectedProject(project);
            if (project && project.id !== 'new-chat-temp') {
                setIsNewChatMode(false);
            }
        },
        clearSelection,
        isNewChatMode,
        setNewChatMode,
        updateNewChatProject,
    };

    return (
        <ChatContext.Provider value={value}>
            {children}
        </ChatContext.Provider>
    );
};

export const useChatContext = (): ChatContextType => {
    const context = useContext(ChatContext);
    if (!context) {
        throw new Error('useChatContext must be used within a ChatProvider');
    }
    return context;
}; 