/** The interactive prompt cards. Standalone so an integrator can pin them
 *  above the composer instead of inside the transcript. */

export {
  PermissionPrompt,
  type PermissionPromptProps,
  type PermissionReply,
} from './permission-prompt.tsx';
export {
  QuestionPrompt,
  type QuestionPromptProps,
  acceptsCustomAnswer,
} from './question-prompt.tsx';
