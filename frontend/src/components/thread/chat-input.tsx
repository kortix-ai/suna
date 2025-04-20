'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Send, Square, Loader2, X, Paperclip, Settings, ChevronDown } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

// Define API_URL
const API_URL = process.env.NEXT_PUBLIC_BACKEND_URL || '';

// Local storage keys
const STORAGE_KEY_MODEL = 'suna-preferred-model';

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
  value: controlledValue,
  onChange: controlledOnChange,
  onFileBrowse,
  sandboxId
}: ChatInputProps) {
  const isControlled = controlledValue !== undefined && controlledOnChange !== undefined;
  
  const [uncontrolledValue, setUncontrolledValue] = useState('');
  const value = isControlled ? controlledValue : uncontrolledValue;

  const [selectedModel, setSelectedModel] = useState("sonnet-3.7");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const savedModel = localStorage.getItem(STORAGE_KEY_MODEL);
        if (savedModel) {
          setSelectedModel(savedModel);
        }
      } catch (error) {
        console.warn('Failed to load preferences from localStorage:', error);
      }
    }
  }, []);
  
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      const newHeight = Math.min(Math.max(textarea.scrollHeight, 24), 200);
      textarea.style.height = `${newHeight}px`;
    };

    adjustHeight();
    
    adjustHeight();

    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, [value]);

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_MODEL, model);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!value.trim() && uploadedFiles.length === 0) || loading || (disabled && !isAgentRunning)) return;
    
    if (isAgentRunning && onStopAgent) {
      onStopAgent();
      return;
    }
    
    let message = value;
    
    if (uploadedFiles.length > 0) {
      const fileInfo = uploadedFiles.map(file => 
        `[Uploaded file: ${file.name} (${formatFileSize(file.size)}) at ${file.path}]`
      ).join('\n');
      message = message ? `${message}\n\n${fileInfo}` : fileInfo;
    }
    
    let baseModelName = selectedModel;
    let thinkingEnabled = false;
    if (selectedModel === "sonnet-3.7-thinking") {
      baseModelName = "sonnet-3.7";
      thinkingEnabled = true;
    }
    
    onSubmit(message, {
      model_name: baseModelName,
      enable_thinking: thinkingEnabled
    });
    
    if (!isControlled) {
      setUncontrolledValue("");
    }
    
    setUploadedFiles([]);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    if (isControlled) {
      controlledOnChange(newValue);
    } else {
      setUncontrolledValue(newValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if ((value.trim() || uploadedFiles.length > 0) && !loading && (!disabled || isAgentRunning)) {
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
    
    event.target.value = '';
  };

  const uploadFiles = async (files: File[]) => {
    try {
      setIsUploading(true);
      
      const newUploadedFiles: UploadedFile[] = [];
      
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024) {
          toast.error(`File size exceeds 50MB limit: ${file.name}`);
          continue;
        }
        
        const formData = new FormData();
        formData.append('file', file);
        
        const uploadPath = `/workspace/${file.name}`;
        formData.append('path', uploadPath);
        
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        
        if (!session?.access_token) {
          throw new Error('No access token available');
        }
        
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
        
        newUploadedFiles.push({
          name: file.name,
          path: uploadPath,
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

  const modelOptions = [
    { id: "sonnet-3.7", label: "Sonnet 3.7" },
    { id: "sonnet-3.7-thinking", label: "Sonnet 3.7 (Thinking)" },
    { id: "gpt-4.1", label: "GPT-4.1" },
    { id: "gemini-flash-2.5", label: "Gemini Flash 2.5" }
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4">
      <AnimatePresence>
        {uploadedFiles.length > 0 && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-2 overflow-hidden"
          >
            <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
              {uploadedFiles.map((file, index) => (
                <motion.div 
                  key={index}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15 }}
                  className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-md flex items-center gap-1.5 group text-sm"
                >
                  <span className="truncate max-w-[120px] text-gray-700 dark:text-gray-300">{file.name}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                    ({formatFileSize(file.size)})
                  </span>
                  <Button 
                    type="button" 
                    variant="ghost" 
                    size="icon" 
                    className="h-4 w-4 rounded-full p-0 hover:bg-gray-200 dark:hover:bg-gray-700"
                    onClick={() => removeUploadedFile(index)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div 
        className={cn(
          "flex items-end w-full rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-2 shadow-sm transition-all duration-200",
          isDraggingOver ? "border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/10" : ""
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="relative flex-1 flex items-center overflow-hidden">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={cn(
              "min-h-[24px] max-h-[200px] py-0 px-0 text-sm resize-none border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent w-full",
              isDraggingOver ? "opacity-40" : ""
            )}
            disabled={loading || (disabled && !isAgentRunning)}
            rows={1}
          />
        </div>
        
        <div className="flex items-center gap-2 pl-2 flex-shrink-0">
          {/* {!isAgentRunning && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button 
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[360px] p-0 gap-0 border border-border shadow-lg">
                      <DialogHeader className="px-4 pt-4 pb-3 border-b">
                        <DialogTitle className="text-sm font-medium">Select Model</DialogTitle>
                      </DialogHeader>
                      <div className="p-4">
                        <RadioGroup 
                          defaultValue={selectedModel} 
                          onValueChange={handleModelChange}
                          className="grid gap-2"
                        >
                          {modelOptions.map(option => (
                            <div key={option.id} className="flex items-center space-x-2 rounded-md px-3 py-2 cursor-pointer hover:bg-accent">
                              <RadioGroupItem value={option.id} id={option.id} />
                              <Label htmlFor={option.id} className="flex-1 cursor-pointer text-sm font-normal">
                                {option.label}
                              </Label>
                              {selectedModel === option.id && (
                                <span className="text-xs text-muted-foreground">Active</span>
                              )}
                            </div>
                          ))}
                        </RadioGroup>
                      </div>
                    </DialogContent>
                  </Dialog>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Settings</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )} */}
          
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button 
                  type="button"
                  onClick={handleFileUpload}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  disabled={loading || (disabled && !isAgentRunning) || isUploading}
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
          
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            onChange={processFileUpload}
            multiple
          />
          
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button 
                  type="submit"
                  onClick={isAgentRunning ? onStopAgent : handleSubmit}
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-8 w-8 rounded-md",
                    isAgentRunning 
                      ? "text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30" 
                      : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800",
                    ((!value.trim() && uploadedFiles.length === 0) && !isAgentRunning) || loading || (disabled && !isAgentRunning) 
                      ? "opacity-50" 
                      : ""
                  )}
                  disabled={((!value.trim() && uploadedFiles.length === 0) && !isAgentRunning) || loading || (disabled && !isAgentRunning)}
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
          className="mt-2 w-full flex items-center justify-center"
        >
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Kortix Suna is working...</span>
          </div>
        </motion.div>
      )}
    </div>
  );
} 