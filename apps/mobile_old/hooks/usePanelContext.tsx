import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

interface PanelContextType {
    isLeftPanelOpen: boolean;
    isRightPanelOpen: boolean;
    openLeftPanel: () => void;
    openRightPanel: () => void;
    closePanels: () => void;
    setLeftPanelOpen: (open: boolean) => void;
    setRightPanelOpen: (open: boolean) => void;
    registerPanelContainer: (ref: PanelContainerRef | null) => void;
}

interface PanelContainerRef {
    openLeftPanel: () => void;
    openRightPanel: () => void;
    closePanels: () => void;
}

const PanelContext = createContext<PanelContextType | undefined>(undefined);

export const PanelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(false);
    const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
    const panelContainerRef = useRef<PanelContainerRef | null>(null);

    const registerPanelContainer = useCallback((ref: PanelContainerRef | null) => {
        panelContainerRef.current = ref;
    }, []);

    const openLeftPanel = useCallback(() => {
        panelContainerRef.current?.openLeftPanel();
    }, []);

    const openRightPanel = useCallback(() => {
        panelContainerRef.current?.openRightPanel();
    }, []);

    const closePanels = useCallback(() => {
        panelContainerRef.current?.closePanels();
    }, []);

    const setLeftPanelOpen = useCallback((open: boolean) => {
        setIsLeftPanelOpen(open);
    }, []);

    const setRightPanelOpen = useCallback((open: boolean) => {
        setIsRightPanelOpen(open);
    }, []);

    const value = {
        isLeftPanelOpen,
        isRightPanelOpen,
        openLeftPanel,
        openRightPanel,
        closePanels,
        setLeftPanelOpen,
        setRightPanelOpen,
        registerPanelContainer,
    };

    return (
        <PanelContext.Provider value={value}>
            {children}
        </PanelContext.Provider>
    );
};

export const usePanelContext = () => {
    const context = useContext(PanelContext);
    if (context === undefined) {
        throw new Error('usePanelContext must be used within a PanelProvider');
    }
    return context;
};

export type { PanelContainerRef };
