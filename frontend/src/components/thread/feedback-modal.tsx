import { Dialog, DialogTitle, DialogHeader, DialogContent, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { Textarea } from "../ui/textarea";
import { toast } from "sonner";


export default function Feedback({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<'positive' | 'negative' | null>(null);
  const [comment, setComment] = useState<string>('');

  const handleClick = (feedback: 'positive' | 'negative') => {
    setFeedback(feedback);
    setOpen(true);
  }

  const handleSubmit = () => {
    if(!feedback) return;
    console.log(messageId, feedback, comment);
    setOpen(false);
    setFeedback(null);
    setComment('');
    toast.success('Feedback submitted');
  }

  return (
    <div className="flex items-center gap-1">
      <Button 
        className="opacity-70 hover:opacity-100" 
        variant="ghost"
        onClick={() => handleClick('positive')}
      >
        <ThumbsUp />
        <span className="sr-only">Positive feedback</span>
      </Button>
      <Button 
        className="opacity-70 hover:opacity-100" 
        size="icon" 
        variant="ghost"
        onClick={() => handleClick('negative')}
      >
        <ThumbsDown />
        <span className="sr-only">Negative feedback</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Feedback</DialogTitle>
          </DialogHeader>
          <span 
            className="text-sm text-muted-foreground"
          >
            {`What was ${feedback === 'negative' ? 'un' : ''}satisifying about this response?`}
          </span>
          <Textarea 
            className="resize-none my-2" 
            placeholder="Please provide feedback..." 
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button onClick={handleSubmit}>Submit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}