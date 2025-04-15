'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

import { Send, Square, Loader2, File, Upload, X, Plus, Paperclip, Image } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
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
  placeholder = "Type your message...",
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
  const [isFocused, setIsFocused] = useState(false);
  
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

  const processFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!sandboxId || !event.target.files || event.target.files.length === 0) return;
    
    try {
      setIsUploading(true);
      
      const files = Array.from(event.target.files);
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
      // Reset the input
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
        <AnimatePresence>
          {uploadedFiles.length > 0 && (
            <motion.div 
              className="space-y-1"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.15 }}
            >
              {uploadedFiles.map((file, index) => (
                <motion.div 
                  key={index} 
                  className="p-2 rounded-lg bg-background border border-border/50 flex items-center justify-between shadow-sm"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.15 }}
                >
                  <div className="flex items-center text-sm">
                    <File className="h-4 w-4 mr-2 text-primary" />
                    <span className="font-medium text-xs">{file.name}</span>
                    <span className="text-[10px] text-muted-foreground ml-2">
                      ({formatFileSize(file.size)})
                    </span>
                  </div>
                  <Button 
                    type="button" 
                    variant="ghost" 
                    size="icon" 
                    className="h-5 w-5 rounded-full hover:bg-background"
                    onClick={() => removeUploadedFile(index)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        
        <div className={cn(
          "relative bg-background border rounded-2xl transition-all duration-150",
          isFocused 
            ? "border-secondary/50 shadow-[0_0_15px_rgba(var(--secondary),0.2)]" 
            : "border-border"
        )}>
          <Textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={
              isAgentRunning 
                ? "Agent is running... type 'stop' to stop" 
                : placeholder
            }
            className="resize-none pr-24 min-h-[48px] max-h-[200px] rounded-2xl border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none py-3"
            disabled={disabled || loading}
            aria-disabled={disabled || loading}
          />
          
          <div className="absolute bottom-2 right-2 flex items-center space-x-1">
            {/* File upload button */}
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              onChange={processFileUpload} 
              multiple 
              disabled={disabled || loading || isUploading || !sandboxId}
            />
            
            {sandboxId && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 rounded-full bg-background/80 hover:bg-muted"
                onClick={handleFileUpload}
                disabled={disabled || loading || isUploading}
              >
                {isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </Button>
            )}
            
            {/* Additional action button (+ button) */}
            {onFileBrowse && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 rounded-full bg-background/80 hover:bg-muted"
                onClick={onFileBrowse}
                disabled={disabled || loading}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            
            {/* Submit or Stop button */}
            <Button
              type="submit"
              size="icon"
              className={cn(
                "h-8 w-8 rounded-full", 
                isAgentRunning 
                  ? "bg-destructive/90 hover:bg-destructive text-white" 
                  : inputValue.trim() || uploadedFiles.length > 0 
                    ? "bg-secondary hover:bg-secondary/90 text-white" 
                    : "bg-muted/70 text-muted-foreground"
              )}
              disabled={((!inputValue.trim() && uploadedFiles.length === 0) && !isAgentRunning) || loading || (disabled && !isAgentRunning)}
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
        </div>
      </form>
    </div>
  );
} 