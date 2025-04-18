'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Send, Square, Loader2, File, Upload, X, Paperclip, FileText, ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// Define API_URL
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Local storage keys
const STORAGE_KEY_MODEL = 'suna-preferred-model';
const STORAGE_KEY_THINKING = 'suna-enable-thinking';

interface ChatInputProps {
  onSubmit: (message: string, options?: { model_name?: string; enable_thinking?: boolean }) => void;
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
  placeholder = "Describe what you need help with...",
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
  const [selectedModel, setSelectedModel] = useState("sonnet-3.7");
  const [enableThinking, setEnableThinking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  
  // Load saved preferences from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        // Load selected model
        const savedModel = localStorage.getItem(STORAGE_KEY_MODEL);
        if (savedModel) {
          setSelectedModel(savedModel);
        }
        
        // Load thinking preference
        const savedThinking = localStorage.getItem(STORAGE_KEY_THINKING);
        if (savedThinking === 'true') {
          setEnableThinking(true);
        }
      } catch (error) {
        console.warn('Failed to load preferences from localStorage:', error);
      }
    }
  }, []);
  
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
      const newHeight = Math.min(Math.max(textarea.scrollHeight, 50), 200); // Min 50px, max 200px
      textarea.style.height = `${newHeight}px`;
    };

    adjustHeight();
    
    // Adjust on window resize too
    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, [inputValue]);

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    // Save to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_MODEL, model);
    }
    
    // Reset thinking when changing away from sonnet-3.7
    if (model !== "sonnet-3.7") {
      setEnableThinking(false);
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY_THINKING, 'false');
      }
    }
  };

  const toggleThinking = () => {
    const newValue = !enableThinking;
    setEnableThinking(newValue);
    // Save to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_THINKING, newValue.toString());
    }
  };

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
    
    onSubmit(message, {
      model_name: selectedModel,
      enable_thinking: enableThinking
    });
    
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

  // Map of model display names
  const modelDisplayNames = {
    "sonnet-3.7": "Sonnet 3.7",
    "gpt-4.1": "GPT-4.1",
    "gemini-flash-2.5": "Gemini Flash 2.5"
  };

  return (
    <div 
      className={cn(
        "w-full border rounded-xl transition-all duration-200 shadow-sm bg-[#1a1a1a] border-gray-800",
        uploadedFiles.length > 0 ? "border-border" : "border-gray-800",
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
                  className="px-2 py-1 bg-gray-800 rounded-full flex items-center gap-1.5 group border border-gray-700 hover:border-gray-600 transition-colors text-sm"
                >
                  {getFileIcon(file.name)}
                  <span className="font-medium truncate max-w-[120px] text-gray-300">{file.name}</span>
                  <span className="text-xs text-gray-400 flex-shrink-0">
                    ({formatFileSize(file.size)})
                  </span>
                  <Button 
                    type="button" 
                    variant="ghost" 
                    size="icon" 
                    className="h-4 w-4 ml-0.5 rounded-full p-0 hover:bg-gray-700"
                    onClick={() => removeUploadedFile(index)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </motion.div>
              ))}
            </div>
            <div className="h-px bg-gray-800 my-2 mx-1" />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center px-3 py-3">
        {/* Left side - Model selector and Think button */}
        {!isAgentRunning && (
          <div className="flex items-center gap-2 mr-3">
            {/* Model selector button with dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="outline" 
                  size="sm"
                  className="h-8 px-3 text-sm text-gray-300 gap-1 border-0 shadow-none bg-transparent hover:bg-gray-800"
                >
                  {modelDisplayNames[selectedModel as keyof typeof modelDisplayNames] || selectedModel}
                  <ChevronDown className="h-3 w-3 ml-1 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bg-gray-900 border-gray-800 text-gray-300">
                <DropdownMenuItem onClick={() => handleModelChange("sonnet-3.7")} className="hover:bg-gray-800">
                  Sonnet 3.7
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleModelChange("gpt-4.1")} className="hover:bg-gray-800">
                  GPT-4.1
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleModelChange("gemini-flash-2.5")} className="hover:bg-gray-800">
                  Gemini Flash 2.5
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            
            {/* Think button - only for Sonnet 3.7 */}
            {selectedModel === "sonnet-3.7" && (
              <Button 
                variant={enableThinking ? "default" : "outline"}
                size="sm"
                className={cn(
                  "h-8 px-3 text-sm",
                  enableThinking 
                    ? "bg-gray-700 text-gray-200 hover:bg-gray-600" 
                    : "text-gray-300 border-0 hover:bg-gray-800"
                )}
                onClick={toggleThinking}
              >
                Think
              </Button>
            )}
          </div>
        )}
        
        {/* Input field */}
        <div className="relative flex-1 flex items-center">
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
              "min-h-[50px] py-3 px-4 text-gray-200 resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent w-full text-base",
              isDraggingOver ? "opacity-20" : ""
            )}
            disabled={loading || (disabled && !isAgentRunning)}
            rows={1}
          />
        </div>
        
        {/* Right side buttons */}
        <div className="flex items-center gap-3 ml-3">
          {/* Attachment button */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button 
                  type="button"
                  onClick={handleFileUpload}
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-8 w-8 rounded-full p-0 text-gray-400 hover:bg-gray-800",
                    isUploading && "text-blue-400"
                  )}
                  disabled={loading || (disabled && !isAgentRunning) || isUploading}
                  aria-label="Upload files"
                >
                  {isUploading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Paperclip className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="bg-gray-900 text-gray-300 border-gray-800">
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
          
          {/* Send button */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button 
                  type="submit"
                  onClick={isAgentRunning ? onStopAgent : handleSubmit}
                  variant={isAgentRunning ? "destructive" : "default"}
                  size="icon"
                  className={cn(
                    "h-10 w-10 rounded-full",
                    !isAgentRunning && "bg-gray-700 hover:bg-gray-600 text-gray-200",
                    isAgentRunning && "bg-red-600 hover:bg-red-700"
                  )}
                  disabled={((!inputValue.trim() && uploadedFiles.length === 0) && !isAgentRunning) || loading || (disabled && !isAgentRunning)}
                  aria-label={isAgentRunning ? 'Stop agent' : 'Send message'}
                >
                  {loading ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : isAgentRunning ? (
                    <Square className="h-5 w-5" />
                  ) : (
                    <Send className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" className="bg-gray-900 text-gray-300 border-gray-800">
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
          className="py-2 px-3 flex items-center justify-center bg-gray-800 border-t border-gray-700 rounded-b-xl"
        >
          <div className="text-xs text-gray-400 flex items-center gap-2">
            <span className="inline-flex items-center">
              <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
              Agent is thinking...
            </span>
            <span className="text-gray-500 border-l border-gray-700 pl-2">
              Press <kbd className="inline-flex items-center justify-center p-0.5 mx-1 bg-gray-700 border border-gray-600 rounded text-xs"><Square className="h-2.5 w-2.5" /></kbd> to stop
            </span>
          </div>
        </motion.div>
      )}
    </div>
  );
} 