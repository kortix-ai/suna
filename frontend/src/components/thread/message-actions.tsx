import { Dialog, DialogTitle, DialogHeader, DialogContent, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ThumbsDown, ThumbsUp, Copy } from "lucide-react";
import { memo, useState } from "react";
import { Textarea } from "../ui/textarea";
import { toast } from "sonner";
import { backendApi } from '@/lib/api-client';

interface MessageActionsProps {
  messageId: string;
  initialFeedback?: boolean | null;
  processedContent?: string;
}

export default memo(function MessageActions({ messageId, initialFeedback = null, processedContent }: MessageActionsProps) {
  const [open, setOpen] = useState(false);
  const [submittedFeedback, setSubmittedFeedback] = useState<boolean | null>(initialFeedback);
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentSelection, setCurrentSelection] = useState<boolean | null>(null);

  const handleClick = (isGood: boolean) => {
    setCurrentSelection(isGood);
    setOpen(true);
  };

  const handleCopy = async () => {
    try {
      if (processedContent) {
        await navigator.clipboard.writeText(processedContent);
        toast.success('Response copied to clipboard');
      } else {
        toast.error('No content to copy');
      }
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      toast.error('Failed to copy to clipboard');
    }
  };

  const handleSubmit = async () => {
    if (currentSelection === null) return;
    
    setIsSubmitting(true);
    
    try {
      const { success } = await backendApi.post('/feedback/', {
        message_id: messageId,
        is_good: currentSelection,
        feedback: feedback.trim() || null,
      });
      
      if (success) {
        setSubmittedFeedback(currentSelection);
        toast.success('Feedback submitted - thank you!');
        setOpen(false);
        setFeedback('');
        setCurrentSelection(null);
      }
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      toast.error('Failed to submit feedback');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setFeedback('');
      setCurrentSelection(null);
    }
  };

  return (
    <div className="flex items-center gap-1 ml-auto justify-end pr-8">
      <button 
        className="h-4 w-4 p-0 rounded-sm hover:bg-muted/50 transition-colors flex items-center justify-center" 
        onClick={handleCopy}
        title="Copy response"
      >
        <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
        <span className="sr-only">Copy response</span>
      </button>
      
      <button 
        className="h-4 w-4 p-0 rounded-sm hover:bg-muted/50 transition-colors flex items-center justify-center" 
        onClick={() => handleClick(true)}
        title="Good response"
      >
        <ThumbsUp className={`h-3 w-3 transition-colors ${
          submittedFeedback === true 
            ? 'fill-current' 
            : 'text-muted-foreground hover:text-foreground'
        }`} />
        <span className="sr-only">Good response</span>
      </button>
      
      <button 
        className="h-4 w-4 p-0 rounded-sm hover:bg-muted/50 transition-colors flex items-center justify-center" 
        onClick={() => handleClick(false)}
        title="Bad response"
      >
        <ThumbsDown className={`h-3 w-3 transition-colors ${
          submittedFeedback === false 
            ? 'fill-current' 
            : 'text-muted-foreground hover:text-foreground'
        }`} />
        <span className="sr-only">Bad response</span>
      </button>
      
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Feedback</DialogTitle>
          </DialogHeader>
          <span className="text-sm text-muted-foreground">
            {`What was ${currentSelection === false ? 'un' : ''}satisfying about this response?`}
          </span>
          <Textarea 
            className="resize-none my-2" 
            placeholder="Please provide feedback..." 
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="outline">
                Cancel
                <span className="sr-only">Cancel feedback</span>
              </Button>
            </DialogClose>
            <Button 
              onClick={handleSubmit} 
              disabled={isSubmitting || currentSelection === null}
            >
              {isSubmitting ? 'Submitting...' : 'Submit'}
              <span className="sr-only">Submit feedback</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});