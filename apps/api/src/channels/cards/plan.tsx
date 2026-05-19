import { Card, CardText, Actions, Button } from 'chat';

interface PlanCardProps {
  title: string;
  summary: string;
  sessionId: string;
  steps?: string[];
}

export function PlanCard({ title, summary, sessionId, steps }: PlanCardProps) {
  return (
    <Card title={title}>
      <CardText>{summary}</CardText>
      {steps && steps.length > 0 ? <CardText>{stepsText(steps)}</CardText> : null}
      <Actions>
        <Button id={`plan.approve:${sessionId}`} style="primary">
          Approve & PR
        </Button>
        <Button id={`plan.revise:${sessionId}`}>Revise</Button>
        <Button id={`plan.reject:${sessionId}`} style="danger">
          Reject
        </Button>
      </Actions>
    </Card>
  );
}

function stepsText(steps: string[]): string {
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}
