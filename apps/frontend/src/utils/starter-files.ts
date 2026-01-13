/**
 * Utility functions for creating and staging starter files for different modes
 */

import { backendApi } from '@/lib/api-client';
import * as XLSX from 'xlsx';

const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

/**
 * Creates a File object from text content
 */
function createTextFile(content: string, filename: string, mimeType: string): File {
  const blob = new Blob([content], { type: mimeType });
  return new File([blob], filename, { type: mimeType });
}

/**
 * Creates a File object from binary content (for Excel files)
 */
function createBinaryFile(content: ArrayBuffer, filename: string, mimeType: string): File {
  const blob = new Blob([content], { type: mimeType });
  return new File([blob], filename, { type: mimeType });
}

/**
 * Stages a file and returns the file_id
 */
async function stageFile(file: File, fileId?: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  if (fileId) {
    formData.append('file_id', fileId);
  }

  const response = await backendApi.upload<{
    file_id: string;
    filename: string;
    storage_path: string;
    mime_type: string;
    status: string;
  }>('/files/stage', formData, { showErrors: false });

  if (response.error) {
    throw new Error(response.error.message || 'Failed to stage file');
  }

  return response.data.file_id;
}

/**
 * Creates an empty Excel file
 */
function createExcelFile(): File {
  // Create workbook and worksheet
  const workbook = XLSX.utils.book_new();
  
  // Create empty worksheet
  const worksheet = XLSX.utils.aoa_to_sheet([]);
  
  // Add worksheet to workbook
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  
  // Write to binary string
  const excelBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  
  return createBinaryFile(excelBuffer, 'spreadsheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/**
 * Starter file contents
 */
const STARTER_FILES = {
  sheets: {
    createFile: createExcelFile,
    filename: 'spreadsheet.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  docs: {
    content: '# Untitled Document\n\nStart writing here...\n',
    filename: 'document.md',
    mimeType: 'text/markdown',
  },
  canvas: {
    content: JSON.stringify({
      name: 'initial',
      version: '1.0',
      background: '#1a1a1a',
      description: 'Initial Canvas - Blank Canvas with Sample Frame',
      elements: [
        {
          id: '17ffd4b0-0c28-489e-9f88-301f53f202e9',
          type: 'frame',
          x: 100.0,
          y: 100.0,
          width: 1080.0,
          height: 1920.0,
          rotation: 0,
          opacity: 1,
          locked: false,
          name: 'Test Frame 1',
          visible: true,
          backgroundColor: '#ffffff',
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, null, 2),
    filename: 'initial.kanvax',
    mimeType: 'application/json',
  },
};

/**
 * Creates and stages a starter file for the given mode
 * Returns the file_id if successful, null otherwise
 */
export async function createAndStageStarterFile(mode: 'sheets' | 'docs' | 'canvas'): Promise<string | null> {
  try {
    const starter = STARTER_FILES[mode];
    if (!starter) {
      console.warn(`[StarterFiles] No starter file defined for mode: ${mode}`);
      return null;
    }

    // For sheets, use the createFile function; for others, use createTextFile
    let file: File;
    if (mode === 'sheets' && 'createFile' in starter) {
      file = starter.createFile();
    } else if ('content' in starter) {
      file = createTextFile(starter.content, starter.filename, starter.mimeType);
    } else {
      console.warn(`[StarterFiles] Invalid starter file structure for mode: ${mode}`);
      return null;
    }
    
    const fileId = await stageFile(file);
    
    console.log(`[StarterFiles] Created and staged ${starter.filename} for mode ${mode}, file_id: ${fileId}`);
    return fileId;
  } catch (error) {
    console.error(`[StarterFiles] Failed to create/stage starter file for mode ${mode}:`, error);
    return null;
  }
}
