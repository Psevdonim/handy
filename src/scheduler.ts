import cron from 'node-cron';
import { Bot } from 'grammy';
import logger from './logger';
import {
  stmtGetBirthdaysToday,
  stmtGetChatsWithChannel,
  stmtGetPendingMemes,
  stmtMarkMeme,
  BirthdayRow,
  MemeRow,
  ChatSettingsRow,
} from './database';
import { pickBirthdayMessage } from './handlers/birthday';

const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';

function getLocalDayMonth(tz: string): { day: number; month: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    day: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  return {
    day: parseInt(parts.find(p => p.type === 'day')!.value),
    month: parseInt(parts.find(p => p.type === 'month')!.value),
  };
}

// top 20% cutoff: smallest value such that 80% of values are below it
function top20Threshold(values: number[]): number {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.8 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function setupScheduler(bot: Bot): void {
  // Birthday notifications at 0:00 AM in configured timezone
  cron.schedule('0 0 * * *', async () => {
    const { day, month } = getLocalDayMonth(TIMEZONE);
    const rows = stmtGetBirthdaysToday.all(day, month) as BirthdayRow[];

    for (const r of rows) {
      let text: string;
      if (r.is_external) {
        text = r.username
          ? pickBirthdayMessage(`@${r.username}`)
          : `🎂 Сегодня день рождения — <b>${r.first_name}</b>!`;
      } else {
        const mention = r.username
          ? `@${r.username}`
          : `<a href="tg://user?id=${r.user_id}">${r.first_name}</a>`;
        text = pickBirthdayMessage(mention);
      }
      try {
        await bot.api.sendMessage(r.chat_id, text, { parse_mode: 'HTML' });
      } catch (e) {
        logger.error(`[birthday] failed to send to chat ${r.chat_id}: ${e}`);
      }
    }
  }, { timezone: TIMEZONE });

  // Meme forwarding: every 3 hours
  cron.schedule('0 */3 * * *', async () => {
    const cutoff = Math.floor(Date.now() / 1000 - 3600 * 6);
    const chats = stmtGetChatsWithChannel.all() as ChatSettingsRow[];

    for (const { chat_id, meme_channel_id } of chats) {
      const memes = stmtGetPendingMemes.all(chat_id, cutoff) as MemeRow[];
      if (memes.length === 0) continue;

      const counts = memes.map(m => m.reaction_count);
      const threshold = top20Threshold(counts);
      logger.info(`[memes] chat ${chat_id}: ${memes.length} pending, threshold=${threshold}`);

      for (const meme of memes) {
        const shouldForward = meme.reaction_count > 0 && meme.reaction_count >= threshold;
        if (shouldForward) {
          try {
            await bot.api.forwardMessage(meme_channel_id, chat_id, meme.message_id);
            stmtMarkMeme.run(1, meme.id);
          } catch (e) {
            logger.error(`[memes] failed to forward ${meme.message_id} from ${chat_id}: ${e}`);
            stmtMarkMeme.run(-1, meme.id);
          }
        } else {
          stmtMarkMeme.run(-1, meme.id);
        }
      }
    }
  });
}
