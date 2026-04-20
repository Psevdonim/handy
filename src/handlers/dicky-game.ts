import { Api, Bot, Context, InlineKeyboard } from 'grammy';
import {
  PlayerRow,
  stmtGetPlayer,
  stmtUpsertPlayer,
  stmtUpdatePlayerValue,
  stmtSetPlayerValue,
  stmtUpdateLastRoll,
  stmtGetTopPlayers,
  stmtGetGameConfig,
  stmtUpsertGameConfig,
} from '../database';

const ROLL_COOLDOWN  = 8 * 3600;
const DEFAULT_START_WAIT = 300;
const DEFAULT_JOIN_WAIT  = 20;

interface Participant { userId: number; name: string }

interface GameSession {
  chatId:      number;
  messageId:   number;
  initiatorId: number;
  bet:         number;
  participants: Participant[];
  status: 'pending' | 'active' | 'finished';
  pendingTimer?: NodeJS.Timeout;
  joinTimer?:   NodeJS.Timeout;
}

const sessions = new Map<number, GameSession>();

// ── Helpers ────────────────────────────────────────────────────────────────

function getCfg(chatId: number) {
  const row = stmtGetGameConfig.get(chatId) as { start_wait: number; join_wait: number } | undefined;
  return {
    startWait: row?.start_wait ?? DEFAULT_START_WAIT,
    joinWait:  row?.join_wait  ?? DEFAULT_JOIN_WAIT,
  };
}

function loadPlayer(chatId: number, userId: number, username: string | null, firstName: string): PlayerRow {
  stmtUpsertPlayer.run(chatId, userId, username, firstName);
  return stmtGetPlayer.get(chatId, userId) as PlayerRow;
}

function setBalance(chatId: number, userId: number, username: string | null, firstName: string, value: number) {
  stmtUpdatePlayerValue.run(value, username, firstName, chatId, userId);
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tag(username: string | null, firstName: string) {
  return username ? `@${esc(username)}` : esc(firstName);
}

function roll() {
  return Math.round((1 + Math.random() * 14) * 100) / 100;
}

// ── Game end ───────────────────────────────────────────────────────────────

async function endGame(api: Api, session: GameSession): Promise<void> {
  if (session.status === 'finished') return;
  session.status = 'finished';
  sessions.delete(session.chatId);

  if (session.participants.length < 2) {
    try {
      await api.editMessageText(
        session.chatId, session.messageId,
        '😔 Вызов истёк — никто не принял.',
        { reply_markup: new InlineKeyboard() }
      );
    } catch {}
    return;
  }

  const winner = session.participants[Math.floor(Math.random() * session.participants.length)];
  const pot    = Math.round(session.bet * session.participants.length * 100) / 100;
  const wp     = stmtGetPlayer.get(session.chatId, winner.userId) as PlayerRow | undefined;
  if (wp) stmtSetPlayerValue.run(wp.value + pot, session.chatId, winner.userId);

  const names = session.participants.map(p => p.name).join(', ');
  try {
    await api.editMessageText(
      session.chatId, session.messageId,
      `🏆 <b>Игра завершена!</b>\n\n` +
      `👥 Участники: ${names}\n` +
      `💰 Банк: ${pot.toFixed(2)} см\n\n` +
      `🎉 Победитель: <b>${winner.name}</b> +${pot.toFixed(2)} см!`,
      { parse_mode: 'HTML' }
    );
  } catch {}
}

// ── Inline keyboard callbacks ──────────────────────────────────────────────

export function setupGameCallbacks(bot: Bot): void {

  // First joiner accepts the challenge
  bot.callbackQuery(/^game_accept:(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]);
    const user   = ctx.from;
    if (!user) return ctx.answerCallbackQuery();

    const session = sessions.get(chatId);
    if (!session || session.status !== 'pending')
      return ctx.answerCallbackQuery({ text: 'Вызов уже истёк.', show_alert: true });

    if (session.initiatorId === user.id)
      return ctx.answerCallbackQuery({ text: 'Нельзя принять собственный вызов!', show_alert: true });

    const player = loadPlayer(chatId, user.id, user.username ?? null, user.first_name);
    if (player.value < session.bet)
      return ctx.answerCallbackQuery({
        text: `Недостаточно см! У тебя ${player.value.toFixed(2)} см, нужно ${session.bet.toFixed(2)}.`,
        show_alert: true,
      });

    const initiator = stmtGetPlayer.get(chatId, session.initiatorId) as PlayerRow | undefined;
    if (!initiator || initiator.value < session.bet)
      return ctx.answerCallbackQuery({
        text: `У инициатора больше нет нужных см для этой ставки.`,
        show_alert: true,
      });

    stmtSetPlayerValue.run(initiator.value - session.bet, chatId, session.initiatorId);
    setBalance(chatId, user.id, user.username ?? null, user.first_name, player.value - session.bet);
    session.participants.push({ userId: user.id, name: tag(user.username ?? null, user.first_name) });
    session.status = 'active';
    if (session.pendingTimer) clearTimeout(session.pendingTimer);

    const cfg   = getCfg(chatId);
    const names = session.participants.map(p => p.name).join(', ');
    const kb    = new InlineKeyboard().text('➕ Присоединиться', `game_join:${chatId}`);

    try {
      await ctx.api.editMessageText(
        chatId, session.messageId,
        `🎮 <b>Игра идёт!</b>\n\n` +
        `💰 Ставка: ${session.bet.toFixed(2)} см\n` +
        `👥 Участники: ${names}\n` +
        `🏦 Банк: ${(session.bet * session.participants.length).toFixed(2)} см\n\n` +
        `⏱ ${cfg.joinWait} сек. чтобы присоединиться!`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } catch {}

    session.joinTimer = setTimeout(() => endGame(ctx.api, session), cfg.joinWait * 1000);
    return ctx.answerCallbackQuery({ text: '✅ Игра началась!' });
  });

  // Other players join during timer
  bot.callbackQuery(/^game_join:(-?\d+)$/, async (ctx) => {
    const chatId = parseInt(ctx.match[1]);
    const user   = ctx.from;
    if (!user) return ctx.answerCallbackQuery();

    const session = sessions.get(chatId);
    if (!session || session.status !== 'active')
      return ctx.answerCallbackQuery({ text: 'Игра уже завершена.', show_alert: true });

    if (session.participants.some(p => p.userId === user.id))
      return ctx.answerCallbackQuery({ text: 'Ты уже в игре!', show_alert: true });

    const player = loadPlayer(chatId, user.id, user.username ?? null, user.first_name);
    if (player.value < session.bet)
      return ctx.answerCallbackQuery({
        text: `Недостаточно см! У тебя ${player.value.toFixed(2)} см, нужно ${session.bet.toFixed(2)}.`,
        show_alert: true,
      });

    setBalance(chatId, user.id, user.username ?? null, user.first_name, player.value - session.bet);
    session.participants.push({ userId: user.id, name: tag(user.username ?? null, user.first_name) });

    const names = session.participants.map(p => p.name).join(', ');
    const pot   = (session.bet * session.participants.length).toFixed(2);
    const kb    = new InlineKeyboard().text('➕ Присоединиться', `game_join:${chatId}`);
    try {
      await ctx.api.editMessageText(
        chatId, session.messageId,
        `🎮 <b>Игра идёт!</b>\n\n` +
        `💰 Ставка: ${session.bet.toFixed(2)} см\n` +
        `👥 Участники (${session.participants.length}): ${names}\n` +
        `🏦 Банк: ${pot} см`,
        { parse_mode: 'HTML', reply_markup: kb }
      );
    } catch {}
    return ctx.answerCallbackQuery({ text: `✅ Ты в игре! Банк: ${pot} см` });
  });
}

// ── Command handler ────────────────────────────────────────────────────────

export async function handleDickyGame(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  const user = ctx.from;
  if (!chat || !user) return;

  const parts = (ctx.match as string).trim().split(/\s+/);
  const sub   = parts[0];
  const name  = tag(user.username ?? null, user.first_name);

  const player = loadPlayer(chat.id, user.id, user.username ?? null, user.first_name);

  if (!sub) {
    await ctx.reply(
      `🎮 <b>Игра в см</b>\n\n` +
      `📏 Твой размер: <b>${player.value.toFixed(2)} см</b>\n\n` +
      `Команды:\n` +
      `/dicky roll — получить см (раз в 8 ч)\n` +
      `/dicky raise N — бросить вызов на N см\n` +
      `/dicky top — таблица лидеров\n`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // ── roll ──────────────────────────────────────────────────────────────────
  if (sub === 'roll') {
    const now = Math.floor(Date.now() / 1000);
    if (player.last_roll !== null && now - player.last_roll < ROLL_COOLDOWN) {
      const left = ROLL_COOLDOWN - (now - player.last_roll);
      const h = Math.floor(left / 3600);
      const m = Math.floor((left % 3600) / 60);
      await ctx.reply(`⏳ Следующий бросок через ${h}ч ${m}м.`);
      return;
    }
    const gained  = roll();
    const newVal  = Math.round((player.value + gained) * 100) / 100;
    setBalance(chat.id, user.id, user.username ?? null, user.first_name, newVal);
    stmtUpdateLastRoll.run(now, chat.id, user.id);
    await ctx.reply(
      `🎲 ${name} бросил кубик!\n+${gained.toFixed(2)} см → *${newVal.toFixed(2)} см*`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // ── raise ─────────────────────────────────────────────────────────────────
  if (sub === 'raise') {
    const existing = sessions.get(chat.id);
    if (existing) {
      const isParticipant = existing.participants.some(p => p.userId === user.id);
      await ctx.reply(
        isParticipant
          ? '🚫 Ты уже участвуешь в текущем состязании — дождись его завершения.'
          : '⚠️ В этом чате уже идёт игра. Дождитесь завершения.'
      );
      return;
    }
    const bet = Math.round(parseFloat(parts[1]) * 100) / 100;
    if (isNaN(bet) || bet <= 0) {
      await ctx.reply('Укажи ставку: /dicky raise 10');
      return;
    }
    if (player.value < bet) {
      await ctx.reply(`Недостаточно см! У тебя ${player.value.toFixed(2)} см.`);
      return;
    }

    const cfg = getCfg(chat.id);
    const kb  = new InlineKeyboard().text('🚀 Поехали', `game_accept:${chat.id}`);
    const msg = await ctx.reply(
      `⚔️ *${name} бросает вызов!*\n\n` +
      `💰 Ставка: *${bet.toFixed(2)} см*\n\n` +
      `Нажми *Поехали* чтобы принять.\nВызов истекает через ${cfg.startWait}с.`,
      { parse_mode: 'HTML', reply_markup: kb }
    );

    const session: GameSession = {
      chatId: chat.id, messageId: msg.message_id,
      initiatorId: user.id, bet,
      participants: [{ userId: user.id, name }],
      status: 'pending',
    };
    session.pendingTimer = setTimeout(
      () => endGame(ctx.api, session),
      cfg.startWait * 1000
    );
    sessions.set(chat.id, session);
    return;
  }

  // ── top ───────────────────────────────────────────────────────────────────
  if (sub === 'top') {
    const rows = stmtGetTopPlayers.all(chat.id) as Array<{ username: string | null; first_name: string; value: number }>;
    if (rows.length === 0) {
      await ctx.reply('Ещё никто не играл в этом чате.');
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines  = rows.map((r, i) =>
      `${medals[i] ?? `${i + 1}.`} ${tag(r.username, r.first_name)} — ${r.value.toFixed(2)} см`
    );
    await ctx.reply(`🏆 <b>Таблица лидеров</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    return;
  }

  // ── config ────────────────────────────────────────────────────────────────
  if (sub === 'config') {
    const member = await ctx.getChatMember(user.id);
    if (!['administrator', 'creator'].includes(member.status)) {
      await ctx.reply('Только администраторы могут менять настройки.');
      return;
    }
    const key = parts[1];
    const val = parseInt(parts[2]);
    const cfg = getCfg(chat.id);

    if (!key) {
      await ctx.reply(
        `⚙️ <b>Настройки игры</b>\n\n` +
        `\`start_wait\` — ${cfg.startWait}с (ожидание принятия вызова)\n` +
        `\`join_wait\` — ${cfg.joinWait}с (ожидание присоединения)\n\n` +
        `Изменить: /dicky config start_wait 300`,
        { parse_mode: 'HTML' }
      );
      return;
    }
    if (!['start_wait', 'join_wait'].includes(key) || isNaN(val) || val < 5) {
      await ctx.reply('Используй: /dicky config start_wait <сек> или join_wait <сек> (мин. 5)');
      return;
    }
    stmtUpsertGameConfig.run({
      chat_id:    chat.id,
      start_wait: key === 'start_wait' ? val : cfg.startWait,
      join_wait:  key === 'join_wait'  ? val : cfg.joinWait,
    });
    await ctx.reply(`✅ ${key} = ${val}с`);
    return;
  }

  await ctx.reply('Используй /dicky для справки.');
}
