import { notifyPermissionRequest, notifyQuestion } from '../../platform/ui';
import { qk } from '../query-keys';
import type { HandlerContext } from './handler-context';
import { asStringOrUndefined, notificationSessionId } from './helpers';
import type { RuntimeEvent } from './types';
export function handleInteractionEvent(event: RuntimeEvent, ctx: HandlerContext) {
  const { addPermission, removePermission, addQuestion, removeQuestion, getSessionTitle } = ctx;
  // A sub-agent's request blocks the turn too: it names the stream's session.
  const notifiedId = (runtimeId: string) =>
    notificationSessionId(ctx.queryClient, ctx.projectId, ctx.sessionId, runtimeId, true) ?? runtimeId;
  // The session lists read Needs you from GET needs-input (KRTX-1739). A
  // question opens or closes now: refetch it, not at the next 30 s poll. The
  // API closes the stored question before it returns the answer.
  if (event.type.startsWith('question.') && ctx.projectId) {
    ctx.queryClient.invalidateQueries({ queryKey: qk.project.needsInput(ctx.projectId) });
  }
  switch (event.type) {
    case 'permission.asked': {
      const props = event.properties;
      if (props.id && props.sessionID) {
        addPermission(props);
        const rawProps: { tool?: unknown; type?: unknown } = props;
        const toolName =
          asStringOrUndefined(rawProps.tool) ?? asStringOrUndefined(rawProps.type) ?? 'a tool';
        notifyPermissionRequest(notifiedId(props.sessionID), toolName, getSessionTitle(props.sessionID));
      }
      break;
    }
    case 'permission.replied': {
      const requestID = event.properties.requestID;
      if (requestID) removePermission(requestID);
      break;
    }
    case 'question.asked': {
      const props = event.properties;
      if (props.id && props.sessionID) {
        addQuestion(props);
        const questionText =
          props.questions[0]?.question || props.questions[0]?.header || 'Kortix needs your input';
        notifyQuestion(notifiedId(props.sessionID), questionText, getSessionTitle(props.sessionID));
      }
      break;
    }
    case 'question.replied':
    case 'question.rejected': {
      const requestID = event.properties.requestID;
      if (requestID) removeQuestion(requestID);
      break;
    }
    default:
      break;
  }
}
