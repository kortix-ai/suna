import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { AgentVersion } from '@/hooks/agents/utils';

interface VersionState {
  currentVersion: AgentVersion | null;
  compareVersion: AgentVersion | null;
  versions: AgentVersion[];
  isViewingVersion: boolean;
  isComparingVersions: boolean;
  hasUnsavedChanges: boolean;
  isLoading: boolean;
  error: string | null;
  
  setCurrentVersion: (version: AgentVersion | null) => void;
  setCompareVersion: (version: AgentVersion | null) => void;
  setVersions: (versions: AgentVersion[]) => void;
  setIsViewingVersion: (viewing: boolean) => void;
  setIsComparingVersions: (comparing: boolean) => void;
  setHasUnsavedChanges: (hasChanges: boolean) => void;
  setIsLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  
  clearVersionState: () => void;
  isViewingOldVersion: (currentVersionId?: string) => boolean;
}

export const useAgentVersionStore = create<VersionState>()(
  devtools(
    persist(
      (set, get) => ({
        currentVersion: null,
        compareVersion: null,
        versions: [],
        isViewingVersion: false,
        isComparingVersions: false,
        hasUnsavedChanges: false,
        isLoading: false,
        error: null,
        
        setCurrentVersion: (version) => set({ 
          currentVersion: version,
          isViewingVersion: version !== null
        }),
        
        setCompareVersion: (version) => set({ 
          compareVersion: version,
          isComparingVersions: version !== null
        }),
        
        setVersions: (versions) => set({ versions }),
        
        setIsViewingVersion: (viewing) => set({ isViewingVersion: viewing }),
        
        setIsComparingVersions: (comparing) => set({ 
          isComparingVersions: comparing,
          compareVersion: comparing ? get().compareVersion : null
        }),
        
        setHasUnsavedChanges: (hasChanges) => set({ hasUnsavedChanges: hasChanges }),
        setIsLoading: (loading) => set({ isLoading: loading }),
        setError: (error) => set({ error }),
        
        clearVersionState: () => set({
          currentVersion: null,
          compareVersion: null,
          versions: [],
          isViewingVersion: false,
          isComparingVersions: false,
          hasUnsavedChanges: false,
          isLoading: false,
          error: null
        }),
        
        isViewingOldVersion: (currentVersionId?: string) => {
          const state = get();
          return state.isViewingVersion && 
                 state.currentVersion !== null && 
                 state.currentVersion.version_id !== currentVersionId;
        }
      }),
      {
        name: 'agent-version-store',
        partialize: (state) => ({
          hasUnsavedChanges: state.hasUnsavedChanges
        })
      }
    ),
    {
      name: 'agent-version-store'
    }
  )
);
