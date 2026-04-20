import { Context, InlineKeyboard, InlineQueryResultBuilder } from 'grammy';
import { stmtGetGayScore, stmtUpsertGayScore, stmtGetReactionRanking } from '../database';

const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';

function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}

function bar(value: number): string {
  const filled = Math.round(value / 10);
  return '🟣'.repeat(filled) + '⬜'.repeat(10 - filled);
}

function buildText(name: string, value: number, isNew: boolean): string {
  return (
    `🌈 *${name}*, насколько ты гей сегодня?\n\n` +
    `${bar(value)} *${value.toFixed(2)}%*\n\n` +
    (isNew ? '_Новый результат на сегодня!_' : '_Уже проверял сегодня 😏_')
  );
}

export async function handleGay(ctx: Context): Promise<void> {
  const user = ctx.from;
  if (!user) return;

  const today = todayStr();
  const row = stmtGetGayScore.get(user.id) as { value: number; date: string } | undefined;

  let value: number;
  let isNew: boolean;

  if (row?.date === today) {
    value = row.value;
    isNew = false;
  } else {
    value = Math.round(Math.random() * 10000) / 100;
    stmtUpsertGayScore.run(user.id, value, today);
    isNew = true;
  }

  const name = user.username ? `@${user.username}` : user.first_name;
  const kb = new InlineKeyboard().switchInline('🔗 Поделиться');

  await ctx.reply(buildText(name, value, isNew), {
    parse_mode: 'Markdown',
    reply_markup: kb,
  });
}

export async function handleGayInlineQuery(ctx: Context): Promise<void> {
  const user = ctx.from;
  if (!user) return;

  const today = todayStr();
  const row = stmtGetGayScore.get(user.id) as { value: number; date: string } | undefined;

  let value: number;
  if (row?.date === today) {
    value = row.value;
  } else {
    value = Math.round(Math.random() * 10000) / 100;
    stmtUpsertGayScore.run(user.id, value, today);
  }

  const name = user.username ? `@${user.username}` : user.first_name;
  const text = buildText(name, value, false);

  await ctx.answerInlineQuery([
    InlineQueryResultBuilder.article('gay_result', '🌈 Поделиться результатом', {
      description: `${value.toFixed(2)}% гей сегодня`,
    }).text(text, { parse_mode: 'Markdown' }),
  ], { cache_time: 0 });
}

export async function handleGayRating(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  if (!chat) return;

  const rankings = stmtGetReactionRanking.all(chat.id) as { user_id: number; total_reactions: number }[];

  if (rankings.length === 0) {
    await ctx.reply('Пока нет реакций на сообщения в этом чате. 😔');
    return;
  }

  const topReactions = rankings[0].total_reactions;
  const users: { id: number; name: string; percentage: number; total: number }[] = [];

  for (const rank of rankings) {
    try {
      const member = await ctx.api.getChatMember(chat.id, rank.user_id);
      const name = member.user.username ? `@${member.user.username}` : member.user.first_name;
      const percentage = topReactions > 0 ? Math.round((rank.total_reactions / topReactions) * 100) : 0;
      users.push({ id: rank.user_id, name, percentage, total: rank.total_reactions });
    } catch (error) {
      // If can't get member, skip or use ID
      const name = `User ${rank.user_id}`;
      const percentage = topReactions > 0 ? Math.round((rank.total_reactions / topReactions) * 100) : 0;
      users.push({ id: rank.user_id, name, percentage, total: rank.total_reactions });
    }
  }

  // Chief
  const chief = users[0];
  let text = `Рейтинг гейства нашего королевства -\n\n`;
  if (chief) {
    text += `Chief Gay Officer - ${chief.name} (${chief.total})\n\n`;
  }

  // Categories
  const categories = [
    { name: 'Senior Gay\'s', min: 80, max: 100 },
    { name: 'Middle Gay\'s', min: 50, max: 79 },
    { name: 'Junior Gay\'s', min: 10, max: 49 },
    { name: 'Trainee gay\'s', min: 0, max: 9 },
  ];

  for (const cat of categories) {
    const filtered = users.filter(u => u.percentage >= cat.min && u.percentage <= cat.max && u.id !== chief?.id);
    if (filtered.length > 0) {
      text += `${cat.name}:\n`;
      filtered.forEach((u, idx) => {
        text += `${idx + 1}. ${u.name} (${u.percentage}%)\n`;
      });
      text += '\n';
    }
  }

  await ctx.reply(text.trim());
}
