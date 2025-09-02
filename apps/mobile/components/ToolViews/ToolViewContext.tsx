import React, { createContext, ReactNode, useContext, useState } from 'react';

interface ToolViewContextType {
    currentView: 'preview' | 'source';
    setCurrentView: (view: 'preview' | 'source') => void;
    headerExtensions: ReactNode;
    setHeaderExtensions: (extensions: ReactNode) => void;
}

const ToolViewContext = createContext<ToolViewContextType | undefined>(undefined);

export const useToolViewContext = () => {
    const context = useContext(ToolViewContext);
    if (!context) {
        throw new Error('useToolViewContext must be used within a ToolViewProvider');
    }
    return context;
};

export const ToolViewProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [currentView, setCurrentView] = useState<'preview' | 'source'>('preview');
    const [headerExtensions, setHeaderExtensions] = useState<ReactNode>(null);

    return (
        <ToolViewContext.Provider value={{
            currentView,
            setCurrentView,
            headerExtensions,
            setHeaderExtensions
        }}>
            {children}
        </ToolViewContext.Provider>
    );
}; 