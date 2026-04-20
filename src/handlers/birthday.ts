import { Context } from 'grammy';
import {
  stmtSetBirthday,
  stmtDeleteBirthday,
  stmtDeleteExternalBirthday,
  stmtGetChatBirthdays,
  BirthdayRow,
} from '../database';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

const BIRTHDAY_MESSAGES = [
  'С днём рождения, {name}! 🎂 Желаем счастья, здоровья и исполнения всех желаний! 🎉',
  '{name}, с днюхой! 🥳 Пусть этот день будет лучшим в году!',
  'Поздравляем {name} с днём рождения! 🎈 Пусть всё задуманное сбывается!',
  '{name}, ура! 🎊 Сегодня твой день — отмечай на полную!',
  'С праздником, {name}! 🎁 Желаем море позитива и крутых подарков!',
  '{name} — именинник(ца) дня! 🌟 Пусть жизнь будет яркой и насыщенной!',
  'Сегодня день рождения у {name}! 🍰 Желаем всего самого лучшего!',
  '{name}, с днём варенья! 🎂 Пусть этот год принесёт только радость!',
];

export function pickBirthdayMessage(name: string): string {
  const template = BIRTHDAY_MESSAGES[Math.floor(Math.random() * BIRTHDAY_MESSAGES.length)];
  return template.replace('{name}', name);
}

// Stable negative ID for external entries — same name+chat always maps to same ID
function externalId(chatId: number, name: string): number {
  let h = 5381;
  const s = `${chatId}/${name.toLowerCase()}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return -(h || 1);
}

function parseDate(dateStr: string): { day: number; month: number } | null {
  const m = dateStr.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  const day = parseInt(m[1]);
  const month = parseInt(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month };
}

export async function handleBirthday(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const user = ctx.from;
  if (!chatId || !user) return;

  const parts = (ctx.match as string).trim().split(/\s+/);
  const sub = parts[0];

  if (!sub) {
    await ctx.reply(
      '🎂 Команды для дней рождения:\n' +
      '/birthday set DD.MM — сохранить свой ДР\n' +
      '/birthday add @тег DD.MM — добавить ДР по тегу\n' +
      '/birthday add Имя DD.MM — добавить ДР по имени\n' +
      '/birthday delete — удалить свой ДР\n' +
      '/birthday delete @тег — удалить чужой ДР по тегу\n' +
      '/birthday delete Имя — удалить чужой ДР по имени\n' +
      '/birthday list — список ДР в этом чате\n'
    );
    return;
  }

  // ── set (own birthday) ────────────────────────────────────────────────────
  if (sub === 'set') {
    const date = parseDate(parts[1] ?? '');
    if (!date) {
      await ctx.reply('Укажи дату: /birthday set DD.MM\nПример: /birthday set 25.12');
      return;
    }
    stmtSetBirthday.run({
      chat_id: chatId, user_id: user.id,
      username: user.username ?? null, first_name: user.first_name,
      day: date.day, month: date.month, is_external: 0,
    });
    await ctx.reply(`✅ День рождения ${pad(date.day)}.${pad(date.month)} сохранён!`);
    return;
  }

  // ── add (someone else's birthday) ────────────────────────────────────────
  if (sub === 'add') {
    const dateStr = parts[parts.length - 1];
    const nameParts = parts.slice(1, parts.length - 1);
    const date = parseDate(dateStr);

    if (!date || nameParts.length === 0) {
      await ctx.reply('Формат: /birthday add @тег DD.MM или /birthday add Имя DD.MM');
      return;
    }

    const rawName = nameParts.join(' ');
    const isTag = rawName.startsWith('@');
    const username = isTag ? rawName.slice(1) : null;
    const firstName = isTag ? rawName : rawName;
    const fakeId = externalId(chatId, rawName.toLowerCase());

    stmtSetBirthday.run({
      chat_id: chatId, user_id: fakeId,
      username, first_name: firstName,
      day: date.day, month: date.month, is_external: 1,
    });
    await ctx.reply(`✅ День рождения ${rawName} (${pad(date.day)}.${pad(date.month)}) добавлен!`);
    return;
  }

  // ── list ──────────────────────────────────────────────────────────────────
  if (sub === 'list') {
    const rows = stmtGetChatBirthdays.all(chatId) as BirthdayRow[];
    if (rows.length === 0) {
      await ctx.reply('В этом чате пока нет дней рождения.');
      return;
    }
    const lines = ['🎂 Дни рождения в этом чате:\n'];
    for (const r of rows) {
      const name = r.username ? `@${r.username}` : r.first_name;
      lines.push(`${pad(r.day)}.${pad(r.month)} — ${name}`);
    }
    await ctx.reply(lines.join('\n'));
    return;
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (sub === 'delete') {
    const target = parts.slice(1).join(' ').trim();

    if (!target) {
      stmtDeleteBirthday.run(chatId, user.id);
      await ctx.reply('🗑 Твой день рождения удалён из этого чата.');
      return;
    }

    const rawName = target.startsWith('@') ? target : target;
    const lookup = target.startsWith('@') ? target.slice(1) : target;
    stmtDeleteExternalBirthday.run(chatId, lookup, rawName);
    await ctx.reply(`🗑 День рождения ${target} удалён.`);
    return;
  }

  // ── test ──────────────────────────────────────────────────────────────────
  if (sub === 'test') {
    const mention = user.username
      ? `@${user.username}`
      : `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;
    await ctx.reply(pickBirthdayMessage(mention), { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply('Неизвестная команда. Используй /birthday для справки.');
}
