'use client';

import React, { useState, useRef, KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface TagInputProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
  maxTags?: number;
  disabled?: boolean;
}

export const TagInput: React.FC<TagInputProps> = ({
  tags,
  onTagsChange,
  placeholder = "Add tags...",
  className,
  maxTags = 10,
  disabled = false
}) => {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    
    // Check if user typed a comma or pressed enter
    if (value.includes(',')) {
      const newTags = value.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
      addTags(newTags);
      setInputValue('');
      return;
    }
    
    setInputValue(value);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const trimmedValue = inputValue.trim();
      if (trimmedValue) {
        addTags([trimmedValue]);
        setInputValue('');
      }
    } else if (e.key === 'Backspace' && inputValue === '' && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  };

  const addTags = (newTags: string[]) => {
    const filteredTags = newTags.filter(tag => 
      tag.length > 0 && 
      !tags.includes(tag) &&
      tag.length <= 50
    );
    
    const updatedTags = [...tags, ...filteredTags].slice(0, maxTags);
    onTagsChange(updatedTags);
  };

  const removeTag = (index: number) => {
    const newTags = tags.filter((_, i) => i !== index);
    onTagsChange(newTags);
  };

  const handleContainerClick = () => {
    if (!disabled && inputRef.current) {
      inputRef.current.focus();
    }
  };

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "flex flex-wrap gap-1.5 p-3 min-h-[2.5rem] border rounded-md bg-background cursor-text",
          "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
          disabled && "opacity-50 cursor-not-allowed bg-muted"
        )}
        onClick={handleContainerClick}
      >
        {tags.map((tag, index) => (
          <Badge
            key={index}
            variant="outline"
            className="text-xs px-2 py-1 gap-1 bg-muted-foreground/10 hover:bg-muted-foreground/20 transition-colors"
          >
            {tag}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTag(index);
                }}
                className="ml-1 hover:text-destructive transition-colors"
              >
                <X size={12} />
              </button>
            )}
          </Badge>
        ))}
        
        {!disabled && tags.length < maxTags && (
          <Input
            ref={inputRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={tags.length === 0 ? placeholder : ""}
            className="shadow-none flex-1 min-w-[120px] border-none p-0 h-auto focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent"
            disabled={disabled}
          />
        )}
      </div>
      
      {tags.length >= maxTags && (
        <p className="text-xs text-muted-foreground mt-1">
          Maximum {maxTags} tags allowed
        </p>
      )}
    </div>
  );
}; 