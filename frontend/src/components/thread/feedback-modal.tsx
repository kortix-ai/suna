import { Dialog, DialogTitle, DialogHeader, DialogContent, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { Textarea } from "../ui/textarea";
import { toast } from "sonner";
import { apiClient } from '@/lib/api-client';

interface FeedbackProps {
  messageId: string;
}

export default function Feedback({ messageId }: FeedbackProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [responseIsGood, setResponseIsGood] = useState<boolean | null>(null);
  const [feedback, setFeedback] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const handleClick = (isGood: boolean) => {
    setResponseIsGood(isGood);
    setOpen(true);
  };

  const handleSubmit = async () => {
    if (responseIsGood === null) return;
    setSubmitting(true);
    const { success } = await apiClient.post('/api/feedback', {
      message_id: messageId,
      response_is_good: responseIsGood,
      comment: feedback.trim() || null,
    });
    setSubmitting(false);
    if (success) {
      toast.success('Feedback submitted - thank you!');
      setOpen(false);
      setFeedback('');
      setResponseIsGood(null);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <Button 
        className="h-7 w-7 opacity-70 hover:opacity-100" 
        variant="ghost"
        onClick={() => handleClick(true)}
      >
        <ThumbsUp className="h-4 w-4" />
        <span className="sr-only">Good response</span>
      </Button>
      <Button 
        className="h-7 w-7 opacity-70 hover:opacity-100" 
        size="icon" 
        variant="ghost"
        onClick={() => handleClick(false)}
      >
        <ThumbsDown className="h-4 w-4" />
        <span className="sr-only">Bad response</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{responseIsGood ? 'Good response' : 'Bad response'}</DialogTitle>
          </DialogHeader>
          <span 
            className="text-sm text-muted-foreground"
          >
            {`What was ${responseIsGood === false ? 'un' : ''}satisifying about this response?`}
          </span>
          <Textarea 
            className="resize-none my-2" 
            placeholder="Please provide feedback..." 
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleSubmit} disabled={submitting || responseIsGood === null}>
              {submitting ? 'Submitting...' : 'Submit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}