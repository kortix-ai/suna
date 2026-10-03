import { notifyPermissionRequest, notifyQuestion } from '../../platform/ui';
import type { HandlerContext } from './handler-context';
import { asStringOrUndefined } from './helpers';
import type { RuntimeEvent } from './types';
export function handleInteractionEvent(event: RuntimeEvent, ctx: HandlerContext) {
  const { addPermission, removePermission, addQuestion, removeQuestion, getSessionTitle } = ctx;
  switch (event.type) {
    case 'permission.asked': {
      const props = event.properties;
      if (props.id && props.sessionID) {
        addPermission(props);
        const rawProps: { tool?: unknown; type?: unknown } = props;
        const toolName =
          asStringOrUndefined(rawProps.tool) ?? asStringOrUndefined(rawProps.type) ?? 'a tool';
        notifyPermissionRequest(props.sessionID, toolName, getSessionTitle(props.sessionID));
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
        notifyQuestion(props.sessionID, questionText, getSessionTitle(props.sessionID));
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
