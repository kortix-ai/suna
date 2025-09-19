import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

// Types for UI state
export interface FileDownload {
  id: string;
  localPath: string;
  progress: number;
  status: 'pending' | 'downloading' | 'completed' | 'error';
  error?: string;
}

export interface CurrentTool {
  id: string;
  name: string;
  isActive: boolean;
  data?: Record<string, any>;
}

export interface ToolCallSnapshot {
  id: string;
  messageId: string;
  toolCall: any;
  toolResult?: string; // Tool execution result content as JSON string
  index: number;
  timestamp: number;
  isCompleted: boolean;
  browserState?: any; // New field for browser state data
}

export interface Project {
  id: string;
  name: string;
  description: string;
  account_id: string;
  created_at: string;
  updated_at?: string;
  sandbox: {
    vnc_preview?: string;
    sandbox_url?: string;
    id?: string;
    pass?: string;
  };
  is_public?: boolean;
  [key: string]: any;
}

export interface ToolViewState {
  selectedToolCall: any | null;
  selectedMessageId: string | null;
  isTimePlaybackMode: boolean;
  playbackIndex: number;
  playbackMessages: any[];
  toolCallSnapshots: ToolCallSnapshot[];
  currentSnapshotIndex: number;
  navigationMode: 'live' | 'manual';
  isInitialized: boolean;
}

interface UIState {
  // Chat UI state (discardable on cold start)
  currentTool: CurrentTool | null;
  inputDraft: string;
  isTyping: boolean;
  
  // Chat/Project state
  selectedProject: Project | null;
  isNewChatMode: boolean;
  newChatSessionKey: number;
  
  // File management (local device paths + download progress)
  fileDownloads: Map<string, FileDownload>;
  
  // UI preferences (discardable)
  sidebarCollapsed: boolean;
  activePanel: 'chat' | 'files' | 'settings' | null;
  
  // Panel state
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  
  // Tool viewing state
  toolViewState: ToolViewState;
  
  // Loading states
  isGenerating: boolean;
  
  // Actions
  setCurrentTool: (tool: CurrentTool | null) => void;
  setInputDraft: (draft: string) => void;
  setIsTyping: (typing: boolean) => void;
  
  // Chat/Project actions
  setSelectedProject: (project: Project | null) => void;
  setNewChatMode: (enabled: boolean) => void;
  updateNewChatProject: (projectData: Partial<Project>) => void;
  clearSelection: () => void;
  resetNewChatSession: () => void;
  
  addFileDownload: (download: FileDownload) => void;
  updateFileDownload: (id: string, updates: Partial<FileDownload>) => void;
  removeFileDownload: (id: string) => void;
  
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActivePanel: (panel: 'chat' | 'files' | 'settings' | null) => void;
  setIsGenerating: (generating: boolean) => void;
  
  // Panel actions
  setLeftPanelVisible: (visible: boolean) => void;
  setRightPanelVisible: (visible: boolean) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  closePanels: () => void;
  
  // Tool actions
  openToolView: (toolCall: any, messageId: string) => void;
  closeToolView: () => void;
  updateToolSnapshots: (messages: any[]) => void;
  navigateToSnapshot: (index: number) => void;
  setNavigationMode: (mode: 'live' | 'manual') => void;
  jumpToLatest: () => void;
  
  // Legacy time playback (keeping for compatibility)
  startTimePlayback: (messages: any[]) => void;
  setPlaybackIndex: (index: number) => void;
  exitTimePlayback: () => void;
  
  // Batch actions for performance
  updateChatState: (updates: {
    currentTool?: CurrentTool | null;
    inputDraft?: string;
    isTyping?: boolean;
    isGenerating?: boolean;
  }) => void;
  
  // Reset actions
  resetChatState: () => void;
  clearFileDownloads: () => void;
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state - all discardable on cold start
    currentTool: null,
    inputDraft: '',
    isTyping: false,
    selectedProject: null,
    isNewChatMode: true,
    newChatSessionKey: 0,
    fileDownloads: new Map(),
    sidebarCollapsed: false,
    activePanel: null,
    leftPanelVisible: false,
    rightPanelVisible: false,
    toolViewState: {
      selectedToolCall: null,
      selectedMessageId: null,
      isTimePlaybackMode: false,
      playbackIndex: 0,
      playbackMessages: [],
      toolCallSnapshots: [],
      currentSnapshotIndex: 0,
      navigationMode: 'live' as const,
      isInitialized: false,
    },
    isGenerating: false,
    
    // Optimized actions with batched updates
    setCurrentTool: (tool) => set({ currentTool: tool }),
    setInputDraft: (draft) => set({ inputDraft: draft }),
    setIsTyping: (typing) => set({ isTyping: typing }),
    
    // Chat/Project actions
    setSelectedProject: (project) => set({ selectedProject: project }),
    setNewChatMode: (enabled) => set({ isNewChatMode: enabled }),
         updateNewChatProject: (projectData) => set((state) => {
       if (!state.isNewChatMode) return {};
       
       const updatedProject: Project = {
         id: 'new-chat-temp',
         name: 'New Chat',
         description: 'Temporary project for new chat',
         account_id: '',
         sandbox: {},
         created_at: new Date().toISOString(),
         updated_at: new Date().toISOString(),
         ...projectData,
       };
       
       return { selectedProject: updatedProject };
     }),
    clearSelection: () => set({ selectedProject: null }),
    resetNewChatSession: () => set((state) => ({ newChatSessionKey: state.newChatSessionKey + 1 })),
    
    addFileDownload: (download) => set((state) => {
      const newDownloads = new Map(state.fileDownloads);
      newDownloads.set(download.id, download);
      return { fileDownloads: newDownloads };
    }),
    
    updateFileDownload: (id, updates) => set((state) => {
      const newDownloads = new Map(state.fileDownloads);
      const existing = newDownloads.get(id);
      if (existing) {
        newDownloads.set(id, { ...existing, ...updates });
      }
      return { fileDownloads: newDownloads };
    }),
    
    removeFileDownload: (id) => set((state) => {
      const newDownloads = new Map(state.fileDownloads);
      newDownloads.delete(id);
      return { fileDownloads: newDownloads };
    }),
    
    setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
    setActivePanel: (panel) => set({ activePanel: panel }),
    setIsGenerating: (generating) => set({ isGenerating: generating }),
    
    // Panel actions
    setLeftPanelVisible: (visible) => set({ leftPanelVisible: visible }),
    setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
    toggleLeftPanel: () => set((state) => ({ leftPanelVisible: !state.leftPanelVisible })),
    toggleRightPanel: () => set((state) => ({ rightPanelVisible: !state.rightPanelVisible })),
    closePanels: () => set({ leftPanelVisible: false, rightPanelVisible: false }),
    
    // Tool actions
    openToolView: (toolCall, messageId) => set((state) => {
      // First, update the selected tool
      const newToolViewState = {
        ...state.toolViewState,
        selectedToolCall: toolCall,
        selectedMessageId: messageId,
      };
      
      // Find the index of this specific tool in snapshots
      const toolIndex = state.toolViewState.toolCallSnapshots.findIndex(snapshot => 
        snapshot.messageId === messageId && 
        JSON.stringify(snapshot.toolCall) === JSON.stringify(toolCall)
      );
      
      // If found, navigate to that specific tool
      if (toolIndex >= 0) {
        newToolViewState.currentSnapshotIndex = toolIndex;
        newToolViewState.navigationMode = 'manual'; // User explicitly selected this
      }
      
      return {
        toolViewState: newToolViewState,
        rightPanelVisible: true, // FORCE panel to open
      };
    }),
    
    closeToolView: () => set((state) => ({
      toolViewState: {
        ...state.toolViewState,
        selectedToolCall: null,
        selectedMessageId: null,
      },
      rightPanelVisible: false,
    })),
    
    updateToolSnapshots: (messages) => set((state) => {
      console.log('🔍 PARSING', messages.length, 'MESSAGES');
      
      const toolSnapshots: ToolCallSnapshot[] = [];
      
      // Mobile app stores tool execution info in tool results, not assistant messages
      const toolResultMessages = messages.filter(msg => 
          msg.type === 'tool' && msg.content
      );
      
      // Get browser_state messages for screenshots
      const browserStateMessages = messages.filter(msg => 
          msg.type === 'browser_state' && msg.content
      );
      
      console.log('🔍 TOOL RESULTS FOUND:', toolResultMessages.length);
      console.log('🖼️ BROWSER STATES FOUND:', browserStateMessages.length);
      
      toolResultMessages.forEach((resultMsg, index) => {
          let toolContent: any;
          try {
              // Handle nested structure: msg.content.content is the actual JSON string
              const outerContent = resultMsg.content;
              if (outerContent && outerContent.content) {
                  toolContent = JSON.parse(outerContent.content);
              } else if (typeof resultMsg.content === 'string') {
                  toolContent = JSON.parse(resultMsg.content);
              } else {
                  toolContent = resultMsg.content;
              }
              
              const functionName = toolContent?.tool_execution?.function_name;
              console.log('🔧 TOOL CONTENT:', functionName);
              
              if (functionName) {
                  // Convert underscores to hyphens to match registry
                  const registryName = functionName.replace(/_/g, '-');
                  
                  // For browser tools, find the closest browser_state message
                  let browserStateData = null;
                  if (functionName.includes('browser')) {
                      // Find browser_state message closest to this tool result
                      const toolTime = new Date(resultMsg.created_at || resultMsg.timestamp || 0).getTime();
                      let closestBrowserState = null;
                      let closestTimeDiff = Infinity;
                      
                      browserStateMessages.forEach(browserMsg => {
                          const browserTime = new Date(browserMsg.created_at || browserMsg.timestamp || 0).getTime();
                          const timeDiff = Math.abs(browserTime - toolTime);
                          
                          // Within 30 seconds of tool execution
                          if (timeDiff < 30000 && timeDiff < closestTimeDiff) {
                              closestBrowserState = browserMsg;
                              closestTimeDiff = timeDiff;
                          }
                      });
                      
                      if (closestBrowserState) {
                          browserStateData = (closestBrowserState as any).content;
                          console.log('🖼️ BROWSER STATE MATCHED:', registryName, !!browserStateData?.screenshot_base64);
                      }
                  }
                  
                  const snapshot: ToolCallSnapshot = {
                      id: `tool-${index}`,
                      messageId: resultMsg.id || `tool-msg-${index}`,
                      timestamp: resultMsg.timestamp || Date.now(),
                      index: index,
                      isCompleted: true,
                      toolCall: {
                          id: `tool-${index}`,
                          name: registryName,
                          functionName: registryName,
                          arguments: toolContent.tool_execution?.arguments || {},
                      },
                      toolResult: JSON.stringify(toolContent),
                      // Add browser state data if available
                      browserState: browserStateData,
                  };
                  
                  toolSnapshots.push(snapshot);
                  console.log('✅ CREATED SNAPSHOT:', registryName);
              }
          } catch (error) {
              console.log('❌ PARSE ERROR:', error);
          }
      });
      
      console.log('✅ FINAL SNAPSHOTS:', toolSnapshots.length, 'WITH RESULTS:', toolSnapshots.filter(s => s.toolResult).length);
      
      const newToolViewState = { ...state.toolViewState };
      newToolViewState.toolCallSnapshots = toolSnapshots;
      
      if (toolSnapshots.length > 0) {
          const latestIndex = toolSnapshots.length - 1;
          newToolViewState.currentSnapshotIndex = latestIndex;
          newToolViewState.navigationMode = 'live';
          newToolViewState.selectedToolCall = toolSnapshots[latestIndex].toolCall;
          newToolViewState.selectedMessageId = toolSnapshots[latestIndex].messageId;
          newToolViewState.isInitialized = true;
      }
      
      return { toolViewState: newToolViewState };
    }),
    
    navigateToSnapshot: (index) => set((state) => {
      const snapshots = state.toolViewState.toolCallSnapshots;
      if (index < 0 || index >= snapshots.length) return state;
      
      const isLatest = index === snapshots.length - 1;
      
      return {
        toolViewState: {
          ...state.toolViewState,
          currentSnapshotIndex: index,
          navigationMode: isLatest ? 'live' : 'manual',
        }
      };
    }),
    
    setNavigationMode: (mode) => set((state) => ({
      toolViewState: {
        ...state.toolViewState,
        navigationMode: mode,
      }
    })),
    
    jumpToLatest: () => set((state) => {
      const snapshots = state.toolViewState.toolCallSnapshots;
      if (snapshots.length === 0) return state;
      
      return {
        toolViewState: {
          ...state.toolViewState,
          currentSnapshotIndex: snapshots.length - 1,
          navigationMode: 'live',
        }
      };
    }),
    
    jumpToLive: () => set((state) => {
      const snapshots = state.toolViewState.toolCallSnapshots;
      if (snapshots.length === 0) return state;
      
      return {
        toolViewState: {
          ...state.toolViewState,
          currentSnapshotIndex: snapshots.length - 1,
          navigationMode: 'live',
        }
      };
    }),
    
    // Legacy time playback functions
    startTimePlayback: (messages) => set((state) => ({
      toolViewState: {
        ...state.toolViewState,
        isTimePlaybackMode: true,
        playbackMessages: messages,
        playbackIndex: 0,
      },
    })),
    
    setPlaybackIndex: (index) => set((state) => ({
      toolViewState: {
        ...state.toolViewState,
        playbackIndex: Math.max(0, Math.min(index, state.toolViewState.playbackMessages.length - 1)),
      },
    })),
    
    exitTimePlayback: () => set((state) => ({
      toolViewState: {
        ...state.toolViewState,
        isTimePlaybackMode: false,
        playbackMessages: [],
        playbackIndex: 0,
      },
    })),
    
    // Batch update for performance
    updateChatState: (updates) => set((state) => ({
      ...state,
      ...updates,
    })),
    
    // Reset actions
    resetChatState: () => set({
      currentTool: null,
      inputDraft: '',
      isTyping: false,
      isGenerating: false,
      toolViewState: {
        selectedToolCall: null,
        selectedMessageId: null,
        isTimePlaybackMode: false,
        playbackIndex: 0,
        playbackMessages: [],
        toolCallSnapshots: [],
        currentSnapshotIndex: 0,
        navigationMode: 'live',
        isInitialized: false,
      },
    }),
    
    clearFileDownloads: () => set({ fileDownloads: new Map() }),
  }))
);

// Specific atomic selectors to prevent infinite loops
export const useCurrentTool = () => useUIStore((state) => state.currentTool);
export const useInputDraft = () => useUIStore((state) => state.inputDraft);
export const useIsGenerating = () => useUIStore((state) => state.isGenerating);
export const useIsTyping = () => useUIStore((state) => state.isTyping);

// Action selectors (these are stable function references)
export const useSetCurrentTool = () => useUIStore((state) => state.setCurrentTool);
export const useSetInputDraft = () => useUIStore((state) => state.setInputDraft);
export const useSetIsGenerating = () => useUIStore((state) => state.setIsGenerating);
export const useSetIsTyping = () => useUIStore((state) => state.setIsTyping);
export const useUpdateChatState = () => useUIStore((state) => state.updateChatState);
export const useResetChatState = () => useUIStore((state) => state.resetChatState);

export const useFileDownloads = () => useUIStore((state) => state.fileDownloads);
export const useAddFileDownload = () => useUIStore((state) => state.addFileDownload);
export const useUpdateFileDownload = () => useUIStore((state) => state.updateFileDownload);
export const useRemoveFileDownload = () => useUIStore((state) => state.removeFileDownload);
export const useClearFileDownloads = () => useUIStore((state) => state.clearFileDownloads);

// Atomic UI layout selectors
export const useSidebarCollapsed = () => useUIStore((state) => state.sidebarCollapsed);
export const useActivePanel = () => useUIStore((state) => state.activePanel);
export const useSetSidebarCollapsed = () => useUIStore((state) => state.setSidebarCollapsed);
export const useSetActivePanel = () => useUIStore((state) => state.setActivePanel);

// Panel selectors
export const useLeftPanelVisible = () => useUIStore((state) => state.leftPanelVisible);
export const useRightPanelVisible = () => useUIStore((state) => state.rightPanelVisible);
export const useSetLeftPanelVisible = () => useUIStore((state) => state.setLeftPanelVisible);
export const useSetRightPanelVisible = () => useUIStore((state) => state.setRightPanelVisible);
export const useToggleLeftPanel = () => useUIStore((state) => state.toggleLeftPanel);
export const useToggleRightPanel = () => useUIStore((state) => state.toggleRightPanel);
export const useClosePanels = () => useUIStore((state) => state.closePanels);

// Tool selectors
export const useToolViewState = () => useUIStore((state) => state.toolViewState);
export const useOpenToolView = () => useUIStore((state) => state.openToolView);
export const useCloseToolView = () => useUIStore((state) => state.closeToolView);
export const useStartTimePlayback = () => useUIStore((state) => state.startTimePlayback);
export const useSetPlaybackIndex = () => useUIStore((state) => state.setPlaybackIndex);
export const useExitTimePlayback = () => useUIStore((state) => state.exitTimePlayback);

// New tool timeline selectors
export const useUpdateToolSnapshots = () => useUIStore((state) => state.updateToolSnapshots);
export const useNavigateToSnapshot = () => useUIStore((state) => state.navigateToSnapshot);
export const useSetNavigationMode = () => useUIStore((state) => state.setNavigationMode);
export const useJumpToLatest = () => useUIStore((state) => state.jumpToLatest);

// Chat/Project state selectors
export const useSelectedProject = () => useUIStore((state) => state.selectedProject);
export const useIsNewChatMode = () => useUIStore((state) => state.isNewChatMode);
export const useSetSelectedProject = () => useUIStore((state) => state.setSelectedProject);
export const useSetNewChatMode = () => useUIStore((state) => state.setNewChatMode);
export const useUpdateNewChatProject = () => useUIStore((state) => state.updateNewChatProject);
export const useClearSelection = () => useUIStore((state) => state.clearSelection);
export const useResetNewChatSession = () => useUIStore((state) => state.resetNewChatSession);
export const useNewChatSessionKey = () => useUIStore((state) => state.newChatSessionKey);

// All selectors above are atomic and safe from infinite loops 