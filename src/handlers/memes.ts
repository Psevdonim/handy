import { Context } from 'grammy';
import {
  stmtAddMeme,
  stmtSetReactionCount,
  stmtDeltaReactionCount,
  stmtSetMemeChannel,
  stmtGetMemeChannel,
} from '../database';

export async function handleMemeMessage(ctx: Context): Promise<void> {
  const msg = ctx.msg;
  if (!msg || !ctx.chat) return;
  stmtAddMeme.run(ctx.chat.id, msg.message_id, ctx.from?.id ?? 0, msg.date);
}

// Aggregated reaction counts (channels / large groups)
export async function handleReactionCount(ctx: Context): Promise<void> {
  const upd = ctx.update.message_reaction_count;
  if (!upd) return;
  const total = upd.reactions.reduce((s, r) => s + r.total_count, 0);
  stmtSetReactionCount.run(total, upd.chat.id, upd.message_id);
}

// Individual reaction changes (regular groups)
export async function handleReaction(ctx: Context): Promise<void> {
  const upd = ctx.update.message_reaction;
  if (!upd) return;
  const delta = upd.new_reaction.length - upd.old_reaction.length;
  if (delta !== 0) stmtDeltaReactionCount.run(delta, upd.chat.id, upd.message_id);
}

export async function handleSetMemeChannel(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const user = ctx.from;
  if (!chat || !user) return;

  const member = await ctx.getChatMember(user.id);
  if (!['administrator', 'creator'].includes(member.status)) {
    await ctx.reply('Только администраторы могут настраивать канал для мемов.');
    return;
  }

  const arg = (ctx.match as string).trim();

  if (!arg) {
    const row = stmtGetMemeChannel.get(chat.id) as { meme_channel_id: number } | undefined;
    await ctx.reply(
      row
        ? `Текущий канал для мемов: ${row.meme_channel_id}`
        : 'Канал не настроен.\nИспользуй: /setmemechannel -100xxxxxxxxx или @channel_username'
    );
    return;
  }

  let channelId: number;

  if (arg.startsWith('@')) {
    try {
      const ch = await ctx.api.getChat(arg);
      channelId = ch.id;
    } catch {
      await ctx.reply(`Не удалось найти канал ${arg}. Убедись, что бот добавлен в канал как администратор.`);
      return;
    }
  } else {
    channelId = parseInt(arg);
    if (isNaN(channelId)) {
      await ctx.reply('Неверный формат. Используй: /setmemechannel -100xxxxxxxxx или @channel_username');
      return;
    }
  }

  try {
    await ctx.api.getChat(channelId);
  } catch {
    await ctx.reply('Не удалось получить информацию о канале. Убедись, что бот добавлен в канал.');
    return;
  }

  stmtSetMemeChannel.run(chat.id, channelId);
  await ctx.reply(`✅ Канал для мемов установлен: ${channelId}`);
}
