/**
 * The session transcript types, from `@kortix/sdk` (`kortix.transcript.v1`).
 * This module names the few the app uses and adds the two view-model types
 * that exist only here.
 */
import type { FilePart as SdkFilePart, MessageWithParts, Part as SdkPart, TurnLike } from '@kortix/sdk';

export type {
  Message,
  MessageWithParts,
  PermissionRequest,
  QuestionAnswer,
  QuestionInfo,
  QuestionOption,
  QuestionRequest,
  Session,
  SessionStatus,
  TextPart,
  ToolPart,
} from '@kortix/sdk';

/** One user message and the assistant messages that answer it. */
export type Turn = TurnLike<MessageWithParts>;

/**
 * A file part of an optimistic send: the picked file on the device, shown as
 * the bubble's thumbnail until the server echo replaces the message
 * (COR-185). Never on a server part.
 */
export type LocalFilePart = Omit<SdkFilePart, 'url' | 'sessionID' | 'messageID'> & {
  url?: string;
  localUri?: string;
};

export type Part = SdkPart;
