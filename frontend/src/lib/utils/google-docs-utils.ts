import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { backendApi } from '../api-client';

export enum DownloadFormat {
  PDF = 'pdf',
  DOCX = 'docx',
  GOOGLE_DOCS = 'google-docs',
}

export async function downloadDocument(
  format: DownloadFormat,
  sandboxUrl: string,
  docPath: string,
  documentName: string
): Promise<void> {
  try {
    const response = await fetch(`${sandboxUrl}/document/convert-to-${format}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        doc_path: docPath,
        download: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to download ${format}`);
    }
    
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${documentName}.${format}`;
    a.click();
    window.URL.revokeObjectURL(url);
    toast.success(`Downloaded ${documentName} as ${format.toUpperCase()}`, {
      duration: 8000,
    });
  } catch (error) {
    console.error(`Error downloading ${format}:`, error);
    throw error;
  }
}

export const handleGoogleDocsAuth = async (docPath: string, sandboxUrl: string) => {
  try {
    sessionStorage.setItem('google_docs_upload_intent', JSON.stringify({
      doc_path: docPath,
      sandbox_url: sandboxUrl
    }));
    
    const currentUrl = encodeURIComponent(window.location.href);
    const response = await backendApi.get(`/google/auth-url?return_url=${currentUrl}`);
    
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to get auth URL');
    }
    
    const { auth_url } = response.data;
    
    if (auth_url) {
      window.location.href = auth_url;
      return;
    }
  } catch (error) {
    console.error('Failed to initiate Google authentication:', error);
    toast.error('Failed to initiate Google authentication');
  }
};

export const handleGoogleDocsUpload = async (sandboxUrl: string, docPath: string) => {
  if (!sandboxUrl || !docPath) {
    throw new Error('Missing required parameters');
  }
  
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      throw new Error('User not authenticated');
    }

    const response = await backendApi.post('/document-tools/convert-and-upload-to-docs', {
      doc_path: docPath,
      sandbox_url: sandboxUrl,
    }, {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
      timeout: 180000,
    });

    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to upload to Google Docs');
    }

    const result = response.data;
    
    if (!result.success && !result.is_api_enabled) {
      toast.info('Redirecting to Google authentication...', {
        duration: 3000,
      });
      handleGoogleDocsAuth(docPath, sandboxUrl);
      return {
        success: false,
        redirected_to_auth: true,
        message: 'Redirecting to Google authentication'
      };
    }
    
    if (result.google_docs_url) {
      toast.success('🎉 Document uploaded successfully!', {
        action: {
          label: 'Open in Google Docs',
          onClick: () => window.open(result.google_docs_url, '_blank'),
        },
        duration: 20000,
      });
      
      const documentName = docPath.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'document';
      
      return {
        success: true,
        google_docs_url: result.google_docs_url,
        google_docs_file_id: result.google_docs_file_id,
        message: `"${documentName}" uploaded successfully`
      };
    } 
    
    throw new Error(result.message || 'No Google Docs URL returned');
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Upload failed';
    
    if (errorMessage.includes('not authenticated') || errorMessage.includes('401')) {
      toast.info('Please authenticate with Google first', {
        duration: 3000,
      });
      handleGoogleDocsAuth(docPath, sandboxUrl);
      return {
        success: false,
        redirected_to_auth: true,
        message: 'Redirecting to Google authentication'
      };
    }
    
    toast.error(`Failed to upload to Google Docs: ${errorMessage}`);
    throw error;
  }
};

export const checkPendingGoogleDocsUpload = async () => {
  try {
    const params = new URLSearchParams(window.location.search);
    const googleAuth = params.get('google_auth');
    
    if (googleAuth === 'success') {
      const intentStr = sessionStorage.getItem('google_docs_upload_intent');
      
      if (intentStr) {
        const intent = JSON.parse(intentStr);
        sessionStorage.removeItem('google_docs_upload_intent');
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        await handleGoogleDocsUpload(intent.sandbox_url, intent.doc_path);
        
        const url = new URL(window.location.href);
        url.searchParams.delete('google_auth');
        window.history.replaceState({}, document.title, url.toString());
        
        return true;
      }
    } else if (googleAuth === 'error') {
      const error = params.get('error');
      toast.error(`Google authentication failed: ${error || 'Unknown error'}`);
      
      sessionStorage.removeItem('google_docs_upload_intent');
      
      const url = new URL(window.location.href);
      url.searchParams.delete('google_auth');
      url.searchParams.delete('error');
      window.history.replaceState({}, document.title, url.toString());
    }
  } catch (error) {
    console.error('Error checking pending Google Docs upload:', error);
    sessionStorage.removeItem('google_docs_upload_intent');
  }
  
  return false;
};