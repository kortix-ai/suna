import { Dialog, DialogTitle, DialogHeader, DialogContent, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { Textarea } from "../ui/textarea";
import { toast } from "sonner";
import { backendApi } from '@/lib/api-client';

interface FeedbackProps {
  messageId: string;
  initialFeedback?: boolean | null;
}

export default function Feedback({ messageId, initialFeedback = null }: FeedbackProps) {
  const [open, setOpen] = useState(false);
  const [submittedFeedback, setSubmittedFeedback] = useState<boolean | null>(initialFeedback);
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentSelection, setCurrentSelection] = useState<boolean | null>(null);

  const handleClick = (isGood: boolean) => {
    setCurrentSelection(isGood);
    setOpen(true);
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
      // Reset form state when closing without submitting
      setFeedback('');
      setCurrentSelection(null);
    }
  };

  return (
    <div className="flex items-center p-0">
      <button 
        className="h-5 w-5 p-0" 
        onClick={() => handleClick(true)}
      >
        <ThumbsUp className={`h-4 w-4 ${submittedFeedback === true ? 'fill-current' : ''}`} />
        <span className="sr-only">Good response</span>
      </button>
      <button 
        className="h-6 w-6 p-0" 
        onClick={() => handleClick(false)}
      >
        <ThumbsDown className={`h-4 w-4 ${submittedFeedback === false ? 'fill-current' : ''}`} />
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
}