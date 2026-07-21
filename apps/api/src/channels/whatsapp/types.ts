/**
 * Inbound event envelope delivered by the Kortix WhatsApp Gateway.
 *
 * The gateway POSTs one normalized event per delivery, signed with
 * `x-whatsapp-signature`. Field names are snake_case on the wire.
 */
export interface WhatsAppGatewayEvent {
  id: string;
  tenant_id: string;
  account_id: string;
  sequence: number;
  type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** `data` payload for a `message.created` event. */
export interface WhatsAppMessageData {
  id: string;
  whatsapp_message_id: string | null;
  chat_jid: string;
  sender_jid: string | null;
  direction: 'inbound' | 'outbound' | string;
  type: string;
  text: string | null;
  timestamp: string;
}

export function asMessageData(event: WhatsAppGatewayEvent): WhatsAppMessageData | null {
  const data = event.data as Partial<WhatsAppMessageData> | undefined;
  if (!data || typeof data.chat_jid !== 'string' || typeof data.id !== 'string') return null;
  return {
    id: data.id,
    whatsapp_message_id: data.whatsapp_message_id ?? null,
    chat_jid: data.chat_jid,
    sender_jid: data.sender_jid ?? null,
    direction: data.direction ?? 'inbound',
    type: data.type ?? 'unknown',
    text: data.text ?? null,
    timestamp: data.timestamp ?? new Date().toISOString(),
  };
}
