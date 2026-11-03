/**
 * Discord's channel access port (channels/core/channel-access.ts): the
 * project's server install, the installation body the routes answer, the
 * sender of a message as a requester, `GET /users/{id}` for a user's names and
 * avatar, and the CDN for the avatar bytes.
 */
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { config } from '../../config';
import { type ChannelAccessPort, cleanName } from '../core/channel-access';
import { readCapped } from '../core/download';
import { type DiscordUser, discordCall, discordConfigured, discordUnreachable } from './api';
import { DISCORD_USER_ID, discordRequester, loadDiscordInstall } from './installs';

const PROFILE_TIMEOUT_MS = 3_000;

export const discordAccessPort: ChannelAccessPort = {
  platform: 'discord',
  label: CHANNELS.discord.label,
  userId: DISCORD_USER_ID,
  idDescription: 'numeric Discord user id',
  // The avatar is asked for as PNG.
  photoTypes: ['image/png'],

  async connection(projectId) {
    const install = await loadDiscordInstall(projectId);
    // The application's token: the port's API calls read it from config.
    return install && { scopeId: install.guildId, credential: discordConfigured() ? 'app' : null, lists: install };
  },

  // Every Discord channel route that answers the installation answers this body.
  async installation(projectId) {
    const install = await loadDiscordInstall(projectId);
    return (
      install && {
        guild_id: install.guildId,
        guild_name: install.guildName,
        allowed_user_ids: install.allowedUserIds,
        access_request_count: install.accessRequests.length,
      }
    );
  },

  requester: discordRequester,

  // Null: no such user.
  async fetchProfile(_credential, userId) {
    try {
      const user = await discordCall<DiscordUser>('GET /users/{id}', `/users/${userId}`, { timeoutMs: PROFILE_TIMEOUT_MS });
      return {
        username: cleanName(user.username, 32),
        first_name: cleanName(user.global_name, 64),
        last_name: null,
        // The avatar hash names the image and changes with it.
        photo: user.avatar ? { ref: `${user.id}/${user.avatar}`, version: user.avatar } : null,
      };
    } catch (error) {
      if (discordUnreachable(error)) throw error;
      return null;
    }
  },

  async fetchPhoto(_credential, ref, maxBytes) {
    const [id, hash] = ref.split('/');
    if (!id || !hash || !DISCORD_USER_ID.test(id) || !/^(a_)?[0-9a-f]{32}$/.test(hash)) return null;
    const res = await fetch(`${config.DISCORD_CDN_URL.replace(/\/+$/, '')}/avatars/${id}/${hash}.png?size=128`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`discord avatar unavailable (${res.status})`);
    if (!res.ok) return null;
    return readCapped(res, maxBytes);
  },
};
