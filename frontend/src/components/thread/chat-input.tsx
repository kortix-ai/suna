'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Send, Square, Loader2, File, Upload, X, Paperclip, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Define API_URL
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

interface ChatInputProps {
  onSubmit: (message: string) => void;
  placeholder?: string;
  loading?: boolean;
  disabled?: boolean;
  isAgentRunning?: boolean;
  onStopAgent?: () => void;
  autoFocus?: boolean;
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
  placeholder = "Type your message... (Enter to send, Shift+Enter for new line)",
  loading = false,
  disabled = false,
  isAgentRunning = false,
  onStopAgent,
  autoFocus = true,
  value,
  onChange,
  onFileBrowse,
  sandboxId
}: ChatInputProps) {
  const [inputValue, setInputValue] = useState(value || "");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  
  // Allow controlled or uncontrolled usage
  const isControlled = value !== undefined && onChange !== undefined;
  
  // Update local state if controlled and value changes
  useEffect(() => {
    if (isControlled && value !== inputValue) {
      setInputValue(value);
    }
  }, [value, isControlled, inputValue]);

  // Auto-focus on textarea when component loads
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  // Adjust textarea height based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      const newHeight = Math.min(textarea.scrollHeight, 200); // Max height of 200px
      textarea.style.height = `${newHeight}px`;
    };

    adjustHeight();
    
    // Adjust on window resize too
    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, [inputValue]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputValue.trim() && uploadedFiles.length === 0) || loading || (disabled && !isAgentRunning)) return;
    
    if (isAgentRunning && onStopAgent) {
      onStopAgent();
      return;
    }
    
    let message = inputValue;
    
    // Add file information to the message if files were uploaded
    if (uploadedFiles.length > 0) {
      const fileInfo = uploadedFiles.map(file => 
        `[Uploaded file: ${file.name} (${formatFileSize(file.size)}) at ${file.path}]`
      ).join('\n');
      message = message ? `${message}\n\n${fileInfo}` : fileInfo;
    }
    
    onSubmit(message);
    
    if (!isControlled) {
      setInputValue("");
    }
    
    // Reset the uploaded files after sending
    setUploadedFiles([]);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    if (isControlled) {
      onChange(newValue);
    } else {
      setInputValue(newValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if ((inputValue.trim() || uploadedFiles.length > 0) && !loading && (!disabled || isAgentRunning)) {
        handleSubmit(e as React.FormEvent);
      }
    }
  };

  const handleFileUpload = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    
    if (!sandboxId || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    
    const files = Array.from(e.dataTransfer.files);
    await uploadFiles(files);
  };

  const processFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!sandboxId || !event.target.files || event.target.files.length === 0) return;
    
    const files = Array.from(event.target.files);
    await uploadFiles(files);
    
    // Reset the input
    event.target.value = '';
  };

  const uploadFiles = async (files: File[]) => {
    try {
      setIsUploading(true);
      
      const newUploadedFiles: UploadedFile[] = [];
      
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024) { // 50MB limit
          toast.error(`File size exceeds 50MB limit: ${file.name}`);
          continue;
        }
        
        // Create a FormData object
        const formData = new FormData();
        formData.append('file', file);
        
        // Upload to workspace root by default
        const uploadPath = `/workspace/${file.name}`;
        formData.append('path', uploadPath);
        
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        
        if (!session?.access_token) {
          throw new Error('No access token available');
        }
        
        // Upload using FormData
        const response = await fetch(`${API_URL}/sandboxes/${sandboxId}/files`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: formData
        });
        
        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }
        
        // Add to uploaded files
        newUploadedFiles.push({
          name: file.name,
          path: uploadPath,
          size: file.size
        });
        
        toast.success(`File uploaded: ${file.name}`);
      }
      
      // Update the uploaded files state
      setUploadedFiles(prev => [...prev, ...newUploadedFiles]);
      
    } catch (error) {
      console.error("File upload failed:", error);
      toast.error(typeof error === 'string' ? error : (error instanceof Error ? error.message : "Failed to upload file"));
    } finally {
      setIsUploading(false);
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

  const getFileIcon = (fileName: string) => {
    const extension = fileName.split('.').pop()?.toLowerCase();
    
    switch(extension) {
      case 'pdf':
        return <FileText className="h-4 w-4 text-red-500" />;
      case 'doc':
      case 'docx':
        return <FileText className="h-4 w-4 text-blue-500" />;
      case 'xls':
      case 'xlsx':
        return <FileText className="h-4 w-4 text-green-500" />;
      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'gif':
      case 'svg':
        return <FileText className="h-4 w-4 text-purple-500" />;
      default:
        return <FileText className="h-4 w-4 text-gray-500" />;
    }
  };

  return (
    <div 
      className={cn(
        "w-full border rounded-lg transition-all duration-200 shadow-sm",
        uploadedFiles.length > 0 ? "border-border" : "border-input",
        isDraggingOver ? "border-primary border-dashed bg-primary/5" : ""
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <AnimatePresence>
        {uploadedFiles.length > 0 && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="px-3 pt-3 overflow-hidden"
          >
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-1 pb-2">
              {uploadedFiles.map((file, index) => (
                <motion.div 
                  key={index}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15 }}
                  className="px-2 py-1 bg-secondary/20 rounded-full flex items-center gap-1.5 group border border-secondary/30 hover:border-secondary/50 transition-colors text-sm"
                >
                  {getFileIcon(file.name)}
                  <span className="font-medium truncate max-w-[120px]">{file.name}</span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    ({formatFileSize(file.size)})
                  </span>
                  <Button 
                    type="button" 
                    variant="ghost" 
                    size="icon" 
                    className="h-4 w-4 ml-0.5 rounded-full p-0 hover:bg-secondary/50"
                    onClick={() => removeUploadedFile(index)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </motion.div>
              ))}
            </div>
            <div className="h-px bg-border/40 my-2 mx-1" />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative">
        {isDraggingOver && (
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div className="flex flex-col items-center">
              <Upload className="h-6 w-6 text-primary mb-2" />
              <p className="text-sm font-medium text-primary">Drop files to upload</p>
            </div>
          </div>
        )}
        
        <Textarea
          ref={textareaRef}
          value={inputValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            isAgentRunning 
              ? "Agent is thinking..." 
              : placeholder
          }
          className={cn(
            "min-h-[50px] max-h-[200px] pr-24 resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-white",
            isDraggingOver ? "opacity-20" : "",
            isAgentRunning ? "rounded-t-lg" : "rounded-lg"
          )}
          disabled={loading || (disabled && !isAgentRunning)}
          rows={1}
        />
        
        <div className="absolute right-2 bottom-2 flex items-center space-x-1.5">
          {/* Upload file button */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button 
                  type="button"
                  onClick={handleFileUpload}
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-8 w-8 rounded-full transition-all hover:bg-primary/10 hover:text-primary",
                    isUploading && "text-primary"
                  )}
                  disabled={loading || (disabled && !isAgentRunning) || isUploading}
                  aria-label="Upload files"
                >
                  {isUploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Paperclip className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Attach files</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          
          {/* Hidden file input */}
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            onChange={processFileUpload}
            multiple
          />
          
          {/* File browser button */}
          {onFileBrowse && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button 
                    type="button"
                    onClick={onFileBrowse}
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full transition-all hover:bg-primary/10 hover:text-primary"
                    disabled={loading || (disabled && !isAgentRunning)}
                    aria-label="Browse files"
                  >
                    <File className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Browse workspace files</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button 
                  type="submit"
                  onClick={isAgentRunning ? onStopAgent : handleSubmit}
                  variant={isAgentRunning ? "destructive" : "default"}
                  size="icon"
                  className={cn(
                    "h-8 w-8 rounded-full",
                    !isAgentRunning && "bg-primary hover:bg-primary/90",
                    isAgentRunning && "bg-destructive hover:bg-destructive/90"
                  )}
                  disabled={((!inputValue.trim() && uploadedFiles.length === 0) && !isAgentRunning) || loading || (disabled && !isAgentRunning)}
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
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{isAgentRunning ? 'Stop agent' : 'Send message'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {isAgentRunning && (
        <motion.div 
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="py-2 px-3 flex items-center justify-center bg-white border-t rounded-b-lg"
        >
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <span className="inline-flex items-center">
              <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              Agent is thinking...
            </span>
            <span className="text-muted-foreground/60 border-l pl-2">
              Press <kbd className="inline-flex items-center justify-center p-0.5 mx-1 bg-muted border rounded text-xs"><Square className="h-2.5 w-2.5" /></kbd> to stop
            </span>
          </div>
        </motion.div>
      )}
    </div>
  );
} 