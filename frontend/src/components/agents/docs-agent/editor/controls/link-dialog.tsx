'use client';

import { useState, useEffect } from 'react';
import { LinkIcon, UnlinkIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useEditorStore } from '@/lib/stores/use-editor-store';

export function LinkDialog() {
  const { editor } = useEditorStore();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');

  useEffect(() => {
    if (open && editor) {
      // Get current link if editing existing link
      const { href } = editor.getAttributes('link');
      if (href) {
        setUrl(href);
      }

      // Get selected text
      const { from, to } = editor.state.selection;
      const selectedText = editor.state.doc.textBetween(from, to);
      setText(selectedText);
    }
  }, [open, editor]);

  const handleSubmit = () => {
    if (!editor || !url) return;

    // If there's selected text or we're editing an existing link
    if (editor.state.selection.empty && text) {
      // Insert new text with link
      editor
        .chain()
        .focus()
        .insertContent(`<a href="${url}">${text}</a>`)
        .run();
    } else {
      // Apply link to selected text
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink({ href: url })
        .run();
    }

    setOpen(false);
    setUrl('');
    setText('');
  };

  const handleRemoveLink = () => {
    if (!editor) return;
    editor.chain().focus().unsetLink().run();
    setOpen(false);
  };

  const isActive = editor?.isActive('link');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className={cn(
            'h-7 w-7 p-0 rounded-sm transition-colors hover:bg-muted hover:text-foreground',
            isActive && 'bg-muted text-foreground',
          )}
        >
          <LinkIcon className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>
            {isActive ? 'Edit Link' : 'Insert Link'}
          </DialogTitle>
          <DialogDescription>
            Add a URL and optional text for your link.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="url" className="text-right">
              URL
            </Label>
            <Input
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="col-span-3"
            />
          </div>
          {editor?.state.selection.empty && (
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="text" className="text-right">
                Text
              </Label>
              <Input
                id="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Link text"
                className="col-span-3"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          {isActive && (
            <Button
              variant="outline"
              onClick={handleRemoveLink}
              className="mr-auto"
            >
              <UnlinkIcon className="h-4 w-4 mr-2" />
              Remove Link
            </Button>
          )}
          <Button type="submit" onClick={handleSubmit}>
            {isActive ? 'Update' : 'Insert'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
} 