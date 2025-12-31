'use client';

import { memo, useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SpreadsheetComponent } from '@syncfusion/ej2-react-spreadsheet';
import { registerLicense } from '@syncfusion/ej2-base';
import { 
  Table, 
  Plus, 
  Clock, 
  FileSpreadsheet,
  Search,
  Loader2,
  Save,
  X,
  RefreshCw,
  Home,
  Download
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDirectoryQuery } from '@/hooks/files/use-file-queries';
import { backendApi } from '@/lib/api-client';
import { useQueryClient } from '@tanstack/react-query';
import JSZip from 'jszip';
import { useSpreadsheetSync } from '../../tool-views/spreadsheet/useSpreadsheetSync';
import { SyncStatusIndicator } from '../../tool-views/spreadsheet/SyncStatusIndicator';
import { SpreadsheetLoader } from '../../tool-views/spreadsheet/SpreadsheetLoader';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/components/AuthProvider';
import { toast } from 'sonner';
import { useDownloadRestriction } from '@/hooks/billing';

import '../../../../../node_modules/@syncfusion/ej2-base/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-inputs/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-buttons/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-splitbuttons/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-lists/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-navigations/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-popups/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-dropdowns/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-grids/styles/material.css';
import '../../../../../node_modules/@syncfusion/ej2-react-spreadsheet/styles/material.css';
import '../../tool-views/spreadsheet/kortix-spreadsheet-styles.css';

const SYNCFUSION_LICENSE = "Ngo9BigBOggjHTQxAR8/V1JGaF5cXGpCf0x0QHxbf1x2ZFFMYFtbRHZPMyBoS35Rc0RhW3ledHRSRmVeVUx+VEFf";
const SYNCFUSION_BASE_URL = 'https://ej2services.syncfusion.com/production/web-services/api/spreadsheet';

registerLicense(SYNCFUSION_LICENSE);

interface SpreadsheetTab {
  id: string;
  filePath: string;
  fileName: string;
  hasUnsavedChanges: boolean;
}

interface SpreadsheetAppProps {
  sandboxId?: string;
  initialFilePath?: string;
  onFileOpen?: (path: string) => void;
}

interface SpreadsheetEditorHandle {
  forceRefresh: () => void;
  isSyncing: boolean;
}

const SpreadsheetEditor = memo(function SpreadsheetEditor({
  sandboxId,
  filePath,
  fileName,
  isActive,
  onUnsavedChange,
  onActionsReady,
}: {
  sandboxId?: string;
  filePath: string;
  fileName: string;
  isActive: boolean;
  onUnsavedChange: (hasChanges: boolean) => void;
  onActionsReady?: (handle: SpreadsheetEditorHandle | null) => void;
}) {
  const ssRef = useRef<SpreadsheetComponent>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const onUnsavedChangeRef = useRef(onUnsavedChange);
  const prevPendingChangesRef = useRef<boolean | null>(null);
  const prevIsActiveRef = useRef(isActive);
  const { session } = useAuth();
  const { isRestricted: isDownloadRestricted, openUpgradeModal } = useDownloadRestriction({
    featureName: 'files',
  });

  onUnsavedChangeRef.current = onUnsavedChange;

  const {
    syncState,
    isLoading: isSyncLoading,
    handlers: syncHandlers,
    actions
  } = useSpreadsheetSync({
    sandboxId,
    filePath,
    spreadsheetRef: ssRef,
    enabled: isActive && !!filePath,
    debounceMs: 1500,
  });

  // Expose actions to parent
  useEffect(() => {
    if (isActive && onActionsReady) {
      onActionsReady({
        forceRefresh: actions.forceRefresh,
        isSyncing: isSyncLoading || syncState.status === 'syncing',
      });
    }
    return () => {
      if (onActionsReady) {
        onActionsReady(null);
      }
    };
  }, [isActive, onActionsReady, actions.forceRefresh, isSyncLoading, syncState.status]);

  useEffect(() => {
    if (isActive && !prevIsActiveRef.current && !isInitialLoad) {
      actions.forceRefresh();
    }
    prevIsActiveRef.current = isActive;
  }, [isActive, isInitialLoad, actions]);

  useEffect(() => {
    if (!isSyncLoading && syncState.status !== 'idle' && isInitialLoad) {
      setIsInitialLoad(false);
    }
  }, [isSyncLoading, syncState.status, isInitialLoad]);

  const showLoader = isSyncLoading && isInitialLoad;

  useEffect(() => {
    if (prevPendingChangesRef.current !== syncState.pendingChanges) {
      prevPendingChangesRef.current = syncState.pendingChanges;
      onUnsavedChangeRef.current(syncState.pendingChanges);
    }
  }, [syncState.pendingChanges]);

  const saveFile = useCallback(async () => {
    if (!ssRef.current || !filePath) return;
    actions.forceSave();
  }, [filePath, actions]);

  const handleDownload = useCallback(async () => {
    if (isDownloadRestricted) {
      openUpgradeModal();
      return;
    }
    
    if (!sandboxId || !filePath || !session?.access_token) {
      toast.error('Unable to download file');
      return;
    }

    setIsDownloading(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`
        }
      });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success('File downloaded successfully');
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download file');
    } finally {
      setIsDownloading(false);
    }
  }, [sandboxId, filePath, fileName, session, isDownloadRestricted, openUpgradeModal]);

  if (!isActive) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 relative">
        <SpreadsheetComponent
          ref={ssRef}
          openUrl={`${SYNCFUSION_BASE_URL}/open`}
          saveUrl={`${SYNCFUSION_BASE_URL}/save`}
          showRibbon={true}
          showFormulaBar={true}
          showSheetTabs={true}
          allowEditing={true}
          allowOpen={true}
          allowSave={true}
          allowScrolling={true}
          allowResizing={true}
          allowCellFormatting={true}
          allowNumberFormatting={true}
          allowConditionalFormat={true}
          allowDataValidation={true}
          allowHyperlink={true}
          allowInsert={true}
          allowDelete={true}
          allowMerge={true}
          allowSorting={true}
          allowFiltering={true}
          allowWrap={true}
          allowFreezePane={true}
          allowUndoRedo={true}
          allowChart={true}
          allowImage={true}
          enableClipboard={true}
          cellEdit={syncHandlers.handleCellEdit}
          cellSave={syncHandlers.handleCellSave}
          actionComplete={syncHandlers.handleActionComplete}
          beforeSave={syncHandlers.handleBeforeSave}
          saveComplete={syncHandlers.handleSaveComplete}
          created={syncHandlers.handleCreated}
          openComplete={syncHandlers.handleOpenComplete}
          openFailure={syncHandlers.handleOpenFailure}
        />

        {showLoader && (
          <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-sm">
            <SpreadsheetLoader mode="max" />
          </div>
        )}
      </div>
    </div>
  );
});

export const SpreadsheetApp = memo(function SpreadsheetApp({
  sandboxId,
  initialFilePath,
  onFileOpen,
}: SpreadsheetAppProps) {
  const queryClient = useQueryClient();
  const [tabs, setTabs] = useState<SpreadsheetTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showHome, setShowHome] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [activeEditorHandle, setActiveEditorHandle] = useState<SpreadsheetEditorHandle | null>(null);

  const { data: workspaceFiles = [] } = useDirectoryQuery(sandboxId, '/workspace/spreadsheets', {
    enabled: !!sandboxId,
  });

  const spreadsheetFiles = workspaceFiles.filter(f => 
    !f.is_dir && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls') || f.name.endsWith('.csv'))
  );

  const filteredFiles = spreadsheetFiles.filter(f =>
    f.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    if (initialFilePath) {
      openFileInTab(initialFilePath);
    }
  }, [initialFilePath]);

  const generateTabId = () => `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const openFileInTab = useCallback((filePath: string) => {
    const existingTab = tabs.find(t => t.filePath === filePath);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      setShowHome(false);
      return;
    }

    const fileName = filePath.split('/').pop() || 'Spreadsheet';
    const newTab: SpreadsheetTab = {
      id: generateTabId(),
      filePath,
      fileName,
      hasUnsavedChanges: false,
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setShowHome(false);
    onFileOpen?.(filePath);
  }, [tabs, onFileOpen]);

  const closeTab = useCallback((tabId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    
    setTabs(prev => {
      const newTabs = prev.filter(t => t.id !== tabId);
      
      if (activeTabId === tabId) {
        if (newTabs.length > 0) {
          const closedIndex = prev.findIndex(t => t.id === tabId);
          const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
          setActiveTabId(newTabs[newActiveIndex].id);
        } else {
          setActiveTabId(null);
          setShowHome(true);
        }
      }
      
      return newTabs;
    });
  }, [activeTabId]);

  const switchToTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setShowHome(false);
  }, []);

  const goToHome = useCallback(() => {
    setShowHome(true);
  }, []);

  const invalidateDirectory = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['directory', sandboxId, '/workspace/spreadsheets'] });
  }, [queryClient, sandboxId]);

  const generateUniqueFileName = useCallback(() => {
    const existingNames = new Set(spreadsheetFiles.map(f => f.name.toLowerCase()));
    let counter = 1;
    let name = 'Untitled.xlsx';
    while (existingNames.has(name.toLowerCase())) {
      name = `Untitled ${counter}.xlsx`;
      counter++;
    }
    return name;
  }, [spreadsheetFiles]);

  const createEmptyXlsx = useCallback(async (): Promise<Blob> => {
    const zip = new JSZip();
    
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData/>
</worksheet>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

    zip.file('[Content_Types].xml', contentTypes);
    zip.file('_rels/.rels', rels);
    zip.file('xl/workbook.xml', workbook);
    zip.file('xl/_rels/workbook.xml.rels', workbookRels);
    zip.file('xl/worksheets/sheet1.xml', sheet1);
    zip.file('xl/styles.xml', styles);

    return await zip.generateAsync({ 
      type: 'blob', 
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' 
    });
  }, []);

  const createNewSpreadsheet = useCallback(async () => {
    if (!sandboxId) return;
    
    setIsCreating(true);
    
    try {
      const newFileName = generateUniqueFileName();
      const newFilePath = `/workspace/spreadsheets/${newFileName}`;
      
      const blob = await createEmptyXlsx();
      
      const uploadFormData = new FormData();
      uploadFormData.append('path', newFilePath);
      uploadFormData.append('file', blob, newFileName);
      
      await backendApi.uploadPut(`/sandboxes/${sandboxId}/files/binary`, uploadFormData, {
        showErrors: true,
      });
      
      invalidateDirectory();
      openFileInTab(newFilePath);
      
    } catch (error) {
      console.error('Failed to create spreadsheet:', error);
    } finally {
      setIsCreating(false);
    }
  }, [sandboxId, generateUniqueFileName, invalidateDirectory, createEmptyXlsx, openFileInTab]);

  const handleTabUnsavedChange = useCallback((tabId: string, hasChanges: boolean) => {
    setTabs(prev => prev.map(t => 
      t.id === tabId ? { ...t, hasUnsavedChanges: hasChanges } : t
    ));
  }, []);


  const renderTabBar = () => (
    <div className="flex items-center bg-zinc-100/80 dark:bg-zinc-900/80 border-b border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center flex-1 overflow-x-auto scrollbar-hide">
        <button
          onClick={goToHome}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-r border-zinc-200 dark:border-zinc-800 transition-colors shrink-0",
            showHome 
              ? "bg-white dark:bg-zinc-800 text-emerald-600 dark:text-emerald-400" 
              : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
          )}
        >
          <Home className="w-4 h-4" />
          <span>Home</span>
        </button>

        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => switchToTab(tab.id)}
            className={cn(
              "group flex items-center gap-2 px-3 py-2.5 text-sm font-medium border-r border-zinc-200 dark:border-zinc-800 transition-colors shrink-0 max-w-[200px]",
              activeTabId === tab.id && !showHome
                ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white" 
                : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
            )}
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-500 shrink-0" />
            <span className="truncate">{tab.fileName}</span>
            {tab.hasUnsavedChanges && (
              <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
            )}
            <button
              onClick={(e) => closeTab(tab.id, e)}
              className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </button>
        ))}
      </div>

      <div className="flex items-center border-l border-zinc-200 dark:border-zinc-800 shrink-0">
        {/* Refresh button - only show when a spreadsheet tab is active */}
        {activeTabId && !showHome && (
          <button
            onClick={() => activeEditorHandle?.forceRefresh()}
            disabled={activeEditorHandle?.isSyncing}
            className="flex items-center justify-center w-10 h-10 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors disabled:opacity-50 shrink-0"
            title="Refresh spreadsheet"
          >
            <RefreshCw className={cn("w-4 h-4", activeEditorHandle?.isSyncing && "animate-spin")} />
          </button>
        )}
        <button
          onClick={goToHome}
          className="flex items-center justify-center w-10 h-10 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors shrink-0"
          title="Open new file"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );

  const renderHome = () => (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="h-full flex bg-zinc-50/50 dark:bg-zinc-900/50 backdrop-blur-xl"
    >
      <div className="w-64 flex flex-col border-r border-zinc-200/50 dark:border-zinc-800/50 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-xl p-4">
        <div className="flex items-center gap-3 px-2 mb-8 mt-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <Table className="w-5 h-5 text-white" />
          </div>
          <span className="font-semibold text-zinc-900 dark:text-white tracking-tight">Spreadsheets</span>
        </div>

        <Button
          onClick={createNewSpreadsheet}
          disabled={isCreating}
          className="mb-6 group bg-emerald-500 hover:bg-emerald-600 transition-colors text-white font-medium"
          size="lg"
        >
          {isCreating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
          <span className="font-medium">{isCreating ? 'Creating...' : 'New Spreadsheet'}</span>
        </Button>

        <div className="space-y-1">
          <div className="px-3 py-2 rounded-lg bg-zinc-200/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-white text-sm font-medium flex items-center gap-2">
            <Clock className="w-4 h-4 text-emerald-500" />
            Recents
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col bg-white/50 dark:bg-zinc-950/50">
        <div className="h-14 border-b border-zinc-200/50 dark:border-zinc-800/50 flex items-center px-6 gap-4">
          <Search className="w-4 h-4 text-zinc-400" />
          <input
            type="text"
            placeholder="Search spreadsheets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent border-none focus:outline-none text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400"
          />
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="space-y-2">
            <div className="flex items-center px-4 py-2 text-xs font-medium text-zinc-400 uppercase tracking-wider">
              <span className="flex-1">Name</span>
              <span className="w-32">Location</span>
            </div>
            
            {(searchQuery ? filteredFiles : spreadsheetFiles).length > 0 ? (
              (searchQuery ? filteredFiles : spreadsheetFiles).map((file, index) => (
                <motion.button
                  key={file.path || file.name}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: index * 0.02 }}
                  onClick={() => openFileInTab(file.path || `/workspace/spreadsheets/${file.name}`)}
                  className="w-full flex items-center gap-4 px-4 py-3 rounded-xl hover:bg-muted/50 transition-all group text-left"
                >
                  <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-500 group-hover:scale-105 transition-transform">
                    <FileSpreadsheet className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-zinc-900 dark:text-white truncate">
                      {file.name}
                    </div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      Last opened {new Date().toLocaleDateString()}
                    </div>
                  </div>
                  <div className="w-32 text-xs text-zinc-400 truncate">
                     /workspace/spreadsheets
                  </div>
                </motion.button>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
                <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center mb-4">
                  <FileSpreadsheet className="w-8 h-8 opacity-20" />
                </div>
                <p className="text-sm">No spreadsheets found</p>
                <button
                  onClick={createNewSpreadsheet}
                  disabled={isCreating}
                  className="mt-4 text-emerald-500 hover:text-emerald-600 text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  {isCreating && <Loader2 className="w-3 h-3 animate-spin" />}
                  {isCreating ? 'Creating...' : 'Create New'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );

  return (
    <>
      <style>{`
        .e-popup,
        .e-popup-open,
        .e-dropdown-popup,
        .e-colorpicker-popup,
        .e-dialog,
        .e-menu-wrapper,
        .e-contextmenu-wrapper,
        .e-ul,
        .e-menu-popup {
          z-index: 999999 !important;
        }
      `}</style>
      <div className="h-full w-full overflow-hidden flex flex-col">
        {renderTabBar()}
        
        <div className="flex-1 overflow-hidden relative">
          <AnimatePresence mode="wait">
            {showHome && renderHome()}
          </AnimatePresence>

          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "absolute inset-0",
                activeTabId === tab.id && !showHome ? "z-10" : "z-0 pointer-events-none opacity-0"
              )}
            >
              <SpreadsheetEditor
                sandboxId={sandboxId}
                filePath={tab.filePath}
                fileName={tab.fileName}
                isActive={activeTabId === tab.id && !showHome}
                onUnsavedChange={(hasChanges) => handleTabUnsavedChange(tab.id, hasChanges)}
                onActionsReady={activeTabId === tab.id ? setActiveEditorHandle : undefined}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
});

SpreadsheetApp.displayName = 'SpreadsheetApp';
