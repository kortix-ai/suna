'use client';

import React, { useRef, useEffect } from 'react';
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Send, Square, Loader2, File, Upload, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

// Define API_URL
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

interface ChatInputProps {
  onSubmit: (message: string) => void;
  placeholder?: string;
  loading?: boolean;
  disabled?: boolean;
  isAgentRunning?: boolean;
  onStopAgent?: () => void;
  value?: string;
  onChange?: (value: string) => void;
  onFileBrowse?: () => void;
  sandboxId?: string;
}

interface UploadedFile {
  name: string;
  path: string;
  size: number;
}

export function ChatInput({
  onSubmit,
  placeholder = "Type your message...",
  loading = false,
  disabled = false,
  isAgentRunning = false,
  onStopAgent,
  value = '',
  onChange,
  onFileBrowse,
  sandboxId
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedFiles, setUploadedFiles] = React.useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = React.useState(false);

  // Auto-focus on textarea when component loads
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  // Handle textarea height adjustment
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    };

    const observer = new ResizeObserver(adjustHeight);
    observer.observe(textarea);

    return () => observer.disconnect();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || (disabled && !isAgentRunning)) return;

    if (isAgentRunning && onStopAgent) {
      onStopAgent();
      return;
    }

    const message = value.trim();
    if (!message && uploadedFiles.length === 0) return;

    let finalMessage = message;
    if (uploadedFiles.length > 0) {
      const fileInfo = uploadedFiles.map(file => 
        `[Uploaded file: ${file.name} (${formatFileSize(file.size)}) at ${file.path}]`
      ).join('\n');
      finalMessage = message ? `${message}\n\n${fileInfo}` : fileInfo;
    }

    onSubmit(finalMessage);
    setUploadedFiles([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as React.FormEvent);
    }
  };

  const handleFileUpload = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const processFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!sandboxId || !event.target.files?.length) return;
    
    try {
      setIsUploading(true);
      const files = Array.from(event.target.files);
      const newUploadedFiles: UploadedFile[] = [];
      
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024) {
          toast.error(`File size exceeds 50MB limit: ${file.name}`);
          continue;
        }
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('path', `/workspace/${file.name}`);
        
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        
        if (!session?.access_token) {
          throw new Error('No access token available');
        }
        
        const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${session.access_token}` },
          body: formData
        });
        
        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }
        
        newUploadedFiles.push({
          name: file.name,
          path: `/workspace/${file.name}`,
          size: file.size
        });
        
        toast.success(`File uploaded: ${file.name}`);
      }
      
      setUploadedFiles(prev => [...prev, ...newUploadedFiles]);
      
    } catch (error) {
      console.error("File upload failed:", error);
      toast.error(typeof error === 'string' ? error : (error instanceof Error ? error.message : "Failed to upload file"));
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const removeUploadedFile = (index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="w-full">
      <form onSubmit={handleSubmit} className="relative">
        {uploadedFiles.length > 0 && (
          <div className="mb-2 space-y-1">
            {uploadedFiles.map((file, index) => (
              <div key={index} className="p-2 bg-secondary/20 rounded-md flex items-center justify-between">
                <div className="flex items-center text-sm">
                  <File className="h-4 w-4 mr-2 text-primary" />
                  <span className="font-medium">{file.name}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    ({formatFileSize(file.size)})
                  </span>
                </div>
                <Button 
                  type="button" 
                  variant="ghost" 
                  size="icon" 
                  className="h-6 w-6"
                  onClick={() => removeUploadedFile(index)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
        
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isAgentRunning ? "Agent is thinking..." : placeholder}
          className="min-h-[50px] max-h-[200px] pr-20 resize-none"
          disabled={loading || (disabled && !isAgentRunning)}
          rows={1}
        />
        
        <div className="absolute right-2 bottom-2 flex items-center space-x-1">
          <Button 
            type="button"
            onClick={handleFileUpload}
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full"
            disabled={loading || (disabled && !isAgentRunning) || isUploading}
            aria-label="Upload files"
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
          </Button>
          
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            onChange={processFileUpload}
            multiple
          />
          
          {onFileBrowse && (
            <Button 
              type="button"
              onClick={onFileBrowse}
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full"
              disabled={loading || (disabled && !isAgentRunning)}
              aria-label="Browse files"
            >
              <File className="h-4 w-4" />
            </Button>
          )}
          
          <Button 
            type={isAgentRunning ? 'button' : 'submit'}
            onClick={isAgentRunning ? onStopAgent : undefined}
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full"
            disabled={loading || (!isAgentRunning && (!value.trim() && uploadedFiles.length === 0))}
            aria-label={isAgentRunning ? 'Stop agent' : 'Send message'}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isAgentRunning ? (
              <Square className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </form>

      {isAgentRunning && (
        <div className="mt-2 flex items-center justify-center gap-2">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="inline-flex items-center">
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
              Agent is thinking...
            </span>
            <span className="text-muted-foreground/60 border-l pl-1.5">
              Press <kbd className="inline-flex items-center justify-center p-0.5 bg-muted border rounded text-xs"><Square className="h-2.5 w-2.5" /></kbd> to stop
            </span>
          </div>
        </div>
      )}
    </div>
  );
} 