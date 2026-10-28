/**
 * Telegram's channel access port (channels/core/channel-access.ts): the bot's
 * install and token, the installation body the routes answer, the sender of a
 * message as a requester, `getChat` for a user's names and photo, and
 * `getFile` for the photo bytes.
 */
import { type ChannelAccessPort, cleanName } from '../core/channel-access';
import { telegramCall, telegramDownload, telegramUnreachable } from './api';
import { loadTelegramBotToken, loadTelegramInstall, TELEGRAM_USER_ID, telegramRequester } from './installs';

const PROFILE_TIMEOUT_MS = 3_000;

const str = (value: unknown) => (typeof value === 'string' && value ? value : null);

export const telegramAccessPort: ChannelAccessPort = {
  platform: 'telegram',
  label: 'Telegram',
  userId: TELEGRAM_USER_ID,
  idDescription: 'numeric Telegram user id',
  // Telegram profile photos are JPEG; anything else is not served as one.
  photoTypes: ['image/jpeg'],

  async connection(projectId) {
    const [install, token] = await Promise.all([loadTelegramInstall(projectId), loadTelegramBotToken(projectId)]);
    return install && { scopeId: install.botId, credential: token, lists: install };
  },

  // Every Telegram channel route that answers the installation answers this body.
  async installation(projectId) {
    const install = await loadTelegramInstall(projectId);
    return (
      install && {
        bot_id: install.botId,
        username: install.username,
        allowed_user_ids: install.allowedUserIds,
        access_request_count: install.accessRequests.length,
      }
    );
  },

  requester: telegramRequester,

  // Null: Telegram has no chat with this user (never started the bot, or blocked it).
  async fetchProfile(token, userId) {
    try {
      const chat = await telegramCall<Record<string, unknown>>(token, 'getChat', { chat_id: userId }, PROFILE_TIMEOUT_MS);
      const photo = chat.photo as { small_file_id?: unknown; small_file_unique_id?: unknown } | undefined;
      const ref = str(photo?.small_file_id);
      const version = str(photo?.small_file_unique_id);
      return {
        // Names from Telegram get the same cleaning as a stored request's.
        username: cleanName(chat.username, 32),
        first_name: cleanName(chat.first_name, 64),
        last_name: cleanName(chat.last_name, 64),
        photo: ref && version ? { ref, version } : null,
      };
    } catch (error) {
      if (telegramUnreachable(error)) throw error;
      return null;
    }
  },

  async fetchPhoto(token, fileId, maxBytes) {
    try {
      const file = await telegramCall<{ file_path?: string }>(token, 'getFile', { file_id: fileId }, 5_000);
      return file.file_path ? await telegramDownload(token, file.file_path, maxBytes) : null;
    } catch (error) {
      if (telegramUnreachable(error)) throw error;
      return null;
    }
  },
};
