import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SunaModesState {
  selectedMode: string | null;
  selectedCharts: string[];
  selectedOutputFormat: string | null;
  selectedTemplate: string | null;
  selectedDocsType: string | null;
  selectedImageStyle: string | null;
  selectedCanvasAction: string | null;
  selectedVideoStyle: string | null;
  
  setSelectedMode: (mode: string | null) => void;
  setSelectedCharts: (charts: string[]) => void;
  setSelectedOutputFormat: (format: string | null) => void;
  setSelectedTemplate: (template: string | null) => void;
  setSelectedDocsType: (type: string | null) => void;
  setSelectedImageStyle: (style: string | null) => void;
  setSelectedCanvasAction: (action: string | null) => void;
  setSelectedVideoStyle: (style: string | null) => void;
  
  // Combined setters for atomic updates (mode + selection in one call)
  selectTemplate: (templateId: string) => void;
  selectOutputFormat: (formatId: string) => void;
  selectCharts: (charts: string[]) => void;
  selectDocsType: (typeId: string) => void;
  selectImageStyle: (styleId: string) => void;
  selectCanvasAction: (actionId: string) => void;
  selectVideoStyle: (styleId: string) => void;
}

export const useSunaModesStore = create<SunaModesState>()(
  persist(
    (set, get) => ({
      selectedMode: null,
      selectedCharts: [],
      selectedOutputFormat: null,
      selectedTemplate: null,
      selectedDocsType: null,
      selectedImageStyle: null,
      selectedCanvasAction: null,
      selectedVideoStyle: null,
      
      setSelectedMode: (mode: string | null) => {
        // Perform all updates in a single atomic set() call to avoid batching issues
        const updates: Partial<SunaModesState> = { selectedMode: mode };
        
        // Reset mode-specific selections when mode changes
        if (mode !== 'data') {
          updates.selectedCharts = [];
          updates.selectedOutputFormat = null;
        }
        if (mode !== 'slides') {
          updates.selectedTemplate = null;
        }
        if (mode !== 'docs') {
          updates.selectedDocsType = null;
        }
        if (mode !== 'image') {
          updates.selectedImageStyle = null;
        }
        if (mode !== 'canvas') {
          updates.selectedCanvasAction = null;
        }
        if (mode !== 'video') {
          updates.selectedVideoStyle = null;
        }
        
        set(updates);
      },
      
      setSelectedCharts: (charts: string[]) => {
        set({ selectedCharts: charts });
      },
      
      setSelectedOutputFormat: (format: string | null) => {
        set({ selectedOutputFormat: format });
      },
      
      setSelectedTemplate: (template: string | null) => {
        set({ selectedTemplate: template });
      },
      
      setSelectedDocsType: (type: string | null) => {
        set({ selectedDocsType: type });
      },
      
      setSelectedImageStyle: (style: string | null) => {
        set({ selectedImageStyle: style });
      },
      
      setSelectedCanvasAction: (action: string | null) => {
        set({ selectedCanvasAction: action });
      },
      
      setSelectedVideoStyle: (style: string | null) => {
        set({ selectedVideoStyle: style });
      },
      
      // Combined setters - set mode AND selection atomically in one call
      selectTemplate: (templateId: string) => {
        set({
          selectedMode: 'slides',
          selectedTemplate: templateId,
          // Reset other mode selections
          selectedCharts: [],
          selectedOutputFormat: null,
          selectedDocsType: null,
          selectedImageStyle: null,
          selectedCanvasAction: null,
          selectedVideoStyle: null,
        });
      },
      
      selectOutputFormat: (formatId: string) => {
        set((state) => ({
          selectedMode: 'data',
          selectedOutputFormat: formatId,
          // Keep charts for data mode
          selectedCharts: state.selectedCharts,
          // Reset other mode selections
          selectedTemplate: null,
          selectedDocsType: null,
          selectedImageStyle: null,
          selectedCanvasAction: null,
          selectedVideoStyle: null,
        }));
      },
      
      selectCharts: (charts: string[]) => {
        set((state) => ({
          selectedMode: 'data',
          selectedCharts: charts,
          // Keep outputFormat for data mode
          selectedOutputFormat: state.selectedOutputFormat,
          // Reset other mode selections
          selectedTemplate: null,
          selectedDocsType: null,
          selectedImageStyle: null,
          selectedCanvasAction: null,
          selectedVideoStyle: null,
        }));
      },
      
      selectDocsType: (typeId: string) => {
        set({
          selectedMode: 'docs',
          selectedDocsType: typeId,
          // Reset other mode selections
          selectedCharts: [],
          selectedOutputFormat: null,
          selectedTemplate: null,
          selectedImageStyle: null,
          selectedCanvasAction: null,
          selectedVideoStyle: null,
        });
      },
      
      selectImageStyle: (styleId: string) => {
        set({
          selectedMode: 'image',
          selectedImageStyle: styleId,
          // Reset other mode selections
          selectedCharts: [],
          selectedOutputFormat: null,
          selectedTemplate: null,
          selectedDocsType: null,
          selectedCanvasAction: null,
          selectedVideoStyle: null,
        });
      },
      
      selectCanvasAction: (actionId: string) => {
        set({
          selectedMode: 'canvas',
          selectedCanvasAction: actionId,
          // Reset other mode selections
          selectedCharts: [],
          selectedOutputFormat: null,
          selectedTemplate: null,
          selectedDocsType: null,
          selectedImageStyle: null,
          selectedVideoStyle: null,
        });
      },
      
      selectVideoStyle: (styleId: string) => {
        set({
          selectedMode: 'video',
          selectedVideoStyle: styleId,
          // Reset other mode selections
          selectedCharts: [],
          selectedOutputFormat: null,
          selectedTemplate: null,
          selectedDocsType: null,
          selectedImageStyle: null,
          selectedCanvasAction: null,
        });
      },
    }),
    {
      name: 'suna-modes-storage',
      // Version 3: Added docs, image, canvas, video state
      version: 3,
      migrate: (persistedState: any, version: number) => {
        if (version < 2) {
          // Remove selectedMode from old persisted state
          const { selectedMode, ...rest } = persistedState;
          return rest;
        }
        if (version < 3) {
          // Add new state with defaults
          return {
            ...persistedState,
            selectedDocsType: null,
            selectedImageStyle: null,
            selectedCanvasAction: null,
            selectedVideoStyle: null,
          };
        }
        return persistedState;
      },
      partialize: (state) => ({
        selectedCharts: state.selectedCharts,
        selectedOutputFormat: state.selectedOutputFormat,
        selectedTemplate: state.selectedTemplate,
        selectedDocsType: state.selectedDocsType,
        selectedImageStyle: state.selectedImageStyle,
        selectedCanvasAction: state.selectedCanvasAction,
        selectedVideoStyle: state.selectedVideoStyle,
      }),
    }
  )
);

// Convenience hook for backward compatibility
export function useSunaModePersistence() {
  const store = useSunaModesStore();
  
  return {
    selectedMode: store.selectedMode,
    selectedCharts: store.selectedCharts,
    selectedOutputFormat: store.selectedOutputFormat,
    selectedTemplate: store.selectedTemplate,
    selectedDocsType: store.selectedDocsType,
    selectedImageStyle: store.selectedImageStyle,
    selectedCanvasAction: store.selectedCanvasAction,
    selectedVideoStyle: store.selectedVideoStyle,
    setSelectedMode: store.setSelectedMode,
    setSelectedCharts: store.setSelectedCharts,
    setSelectedOutputFormat: store.setSelectedOutputFormat,
    setSelectedTemplate: store.setSelectedTemplate,
    setSelectedDocsType: store.setSelectedDocsType,
    setSelectedImageStyle: store.setSelectedImageStyle,
    setSelectedCanvasAction: store.setSelectedCanvasAction,
    setSelectedVideoStyle: store.setSelectedVideoStyle,
  };
}

