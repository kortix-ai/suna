import { Dialog, DialogTitle, DialogHeader, DialogContent, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { Textarea } from "../ui/textarea";
import { toast } from "sonner";
import { backendApi } from '@/lib/api-client';

type SubmitStatus = 'idle' | 'submitting' | 'success' | 'error';

interface FeedbackProps {
  messageId: string;
  initialFeedback?: boolean | null;
}

export default function Feedback({ messageId, initialFeedback = null }: FeedbackProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [responseIsGood, setResponseIsGood] = useState<boolean | null>(initialFeedback);
  const [feedback, setFeedback] = useState<string>('');
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>(initialFeedback !== null ? 'success' : 'idle');

  const handleClick = (isGood: boolean) => {
    setResponseIsGood(isGood);
    setOpen(true);
  };

  const handleSubmit = async () => {
    if (responseIsGood === null) return;
    setSubmitStatus('submitting');
    
    try {
      const { success } = await backendApi.post('/feedback/', {
        message_id: messageId,
        is_good: responseIsGood,
        feedback: feedback.trim() || null,
      });
      setSubmitStatus('success');
      if (success) {
        toast.success('Feedback submitted - thank you!');
        setOpen(false);
        setFeedback('');
        setSubmitStatus('success');
      }
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      setSubmitStatus('error');
      toast.error('Failed to submit feedback');
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Button 
        className="h-7 w-7 opacity-70 hover:opacity-100" 
        variant="ghost"
        onClick={() => handleClick(true)}
      >
        <ThumbsUp className={`h-4 w-4 ${submitStatus === 'success' && responseIsGood ? 'fill-white' : ''}`} />
        <span className="sr-only">Good response</span>
      </Button>
      <Button 
        className="h-7 w-7 opacity-70 hover:opacity-100" 
        size="icon" 
        variant="ghost"
        onClick={() => handleClick(false)}
      >
        <ThumbsDown className={`h-4 w-4 ${submitStatus === 'success' && responseIsGood === false ? 'fill-white' : ''}`} />
        <span className="sr-only">Bad response</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Feedback</DialogTitle>
          </DialogHeader>
          <span
            className="text-sm text-muted-foreground"
          >
            {`What was ${responseIsGood === false ? 'un' : ''}satisfying about this response?`}
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
            <Button onClick={handleSubmit} disabled={submitStatus === 'submitting' || responseIsGood === null}>
              {submitStatus === 'submitting' ? 'Submitting...' : 'Submit'}
              <span className="sr-only">Submit feedback</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}