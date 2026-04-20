import { Api, Bot, Context, InlineKeyboard } from 'grammy';
import {
  stmtCreateTodoList,
  stmtGetUserTodoLists,
  stmtGetTodoList,
  stmtDeleteTodoListItems,
  stmtDeleteTodoList,
  stmtGetActiveTodoListId,
  stmtSetActiveTodoList,
  stmtGetTodoItems,
  stmtAddTodoItem,
  stmtToggleTodoItem,
  stmtDeleteTodoItem,
} from '../database';

interface TodoList { id: number; name: string }
interface TodoItem { id: number; text: string; done: number }

type UserState =
  | { action: 'add_item'; listId: number; chatId: number; msgId: number }
  | { action: 'new_list'; chatId: number; userId: number; msgId: number };

export const userTodoStates = new Map<number, UserState>();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function ensureActiveList(userId: number, chatId: number): number {
  const row = stmtGetActiveTodoListId.get(userId, chatId) as { list_id: number } | undefined;
  if (row) return row.list_id;
  const res = stmtCreateTodoList.run(chatId, userId, 'Мои задачи');
  const listId = res.lastInsertRowid as number;
  stmtSetActiveTodoList.run(userId, chatId, listId);
  return listId;
}

function buildMainText(list: TodoList, items: TodoItem[]): string {
  const done = items.filter(i => i.done).length;
  let text = `📋 <b>${esc(list.name)}</b>`;
  if (items.length > 0) text += `  <i>${done}/${items.length}</i>`;
  text += '\n\n';
  if (items.length === 0) {
    text += '🫙 <i>Список пуст — добавь первую задачу!</i>';
  } else {
    text += items.map(i =>
      i.done ? `✅ <s>${esc(i.text)}</s>` : `⬜ ${esc(i.text)}`
    ).join('\n');
  }
  return text;
}

function buildMainKeyboard(items: TodoItem[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items) {
    const icon = item.done ? '✅' : '⬜';
    kb.text(`${icon} ${truncate(item.text, 30)}`, `td_toggle:${item.id}`)
      .text('🗑', `td_del:${item.id}`)
      .row();
  }
  kb.text('➕ Добавить', 'td_add').text('📋 Списки', 'td_lists');
  return kb;
}

function buildListsText(lists: TodoList[], activeId: number): string {
  let text = `📚 <b>Мои списки</b>\n\n`;
  text += lists.map(l => (l.id === activeId ? `• <b>${esc(l.name)}</b> ✓` : `• ${esc(l.name)}`)).join('\n');
  return text;
}

function buildListsKeyboard(lists: TodoList[], activeId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const list of lists) {
    const label = (list.id === activeId ? '✓ ' : '') + truncate(list.name, 28);
    kb.text(label, `td_switch:${list.id}`);
    if (list.id !== activeId && lists.length > 1) kb.text('🗑', `td_dellist:${list.id}`);
    kb.row();
  }
  kb.text('➕ Новый список', 'td_newlist').row();
  kb.text('← Назад', 'td_back');
  return kb;
}

async function renderMain(api: Api, chatId: number, userId: number, msgId: number): Promise<void> {
  const listId = ensureActiveList(userId, chatId);
  const list = stmtGetTodoList.get(listId) as TodoList;
  const items = stmtGetTodoItems.all(listId) as TodoItem[];
  try {
    await api.editMessageText(chatId, msgId, buildMainText(list, items), {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(items),
    });
  } catch {}
}

// ── Command ────────────────────────────────────────────────────────────────

export async function handleTodo(ctx: Context): Promise<void> {
  const user = ctx.from;
  const chat = ctx.chat;
  if (!user || !chat) return;
  const listId = ensureActiveList(user.id, chat.id);
  const list = stmtGetTodoList.get(listId) as TodoList;
  const items = stmtGetTodoItems.all(listId) as TodoItem[];
  await ctx.reply(buildMainText(list, items), {
    parse_mode: 'HTML',
    reply_markup: buildMainKeyboard(items),
  });
}

// ── Text input handler (add item / new list name) ──────────────────────────

export async function handleTodoTextInput(ctx: Context): Promise<void> {
  const user = ctx.from;
  if (!user) return;
  const state = userTodoStates.get(user.id);
  if (!state) return;

  const text = ctx.message?.text?.trim();
  if (!text || text.startsWith('/')) return;

  userTodoStates.delete(user.id);
  try { await ctx.deleteMessage(); } catch {}

  if (state.action === 'add_item') {
    const items = text.split(',').map(s => s.trim()).filter(Boolean)
      .map(s => s.charAt(0).toUpperCase() + s.slice(1));
    for (const item of items) stmtAddTodoItem.run(state.listId, item);
  } else if (state.action === 'new_list') {
    const res = stmtCreateTodoList.run(state.chatId, state.userId, text);
    stmtSetActiveTodoList.run(state.userId, state.chatId, res.lastInsertRowid as number);
  }

  await renderMain(ctx.api, state.chatId, user.id, state.msgId);
}

// ── Callbacks ──────────────────────────────────────────────────────────────

export function setupTodoCallbacks(bot: Bot): void {
  bot.callbackQuery(/^td_toggle:(\d+)$/, async (ctx) => {
    stmtToggleTodoItem.run(parseInt(ctx.match[1]));
    await renderMain(ctx.api, ctx.chat!.id, ctx.from.id, ctx.callbackQuery.message!.message_id);
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^td_del:(\d+)$/, async (ctx) => {
    stmtDeleteTodoItem.run(parseInt(ctx.match[1]));
    await renderMain(ctx.api, ctx.chat!.id, ctx.from.id, ctx.callbackQuery.message!.message_id);
    return ctx.answerCallbackQuery({ text: '🗑 Удалено' });
  });

  bot.callbackQuery('td_add', async (ctx) => {
    const chatId = ctx.chat!.id;
    const listId = ensureActiveList(ctx.from.id, chatId);
    const msgId = ctx.callbackQuery.message!.message_id;
    userTodoStates.set(ctx.from.id, { action: 'add_item', listId, chatId, msgId });
    await ctx.api.editMessageText(chatId, msgId,
      '✏️ <b>Новая задача</b>\n\nНапиши текст задачи (можно через запятую):',
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✕ Отмена', 'td_cancel') }
    );
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery('td_cancel', async (ctx) => {
    userTodoStates.delete(ctx.from.id);
    await renderMain(ctx.api, ctx.chat!.id, ctx.from.id, ctx.callbackQuery.message!.message_id);
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery('td_lists', async (ctx) => {
    const chatId = ctx.chat!.id;
    const activeId = ensureActiveList(ctx.from.id, chatId);
    const lists = stmtGetUserTodoLists.all(chatId, ctx.from.id) as TodoList[];
    await ctx.api.editMessageText(chatId, ctx.callbackQuery.message!.message_id,
      buildListsText(lists, activeId),
      { parse_mode: 'HTML', reply_markup: buildListsKeyboard(lists, activeId) }
    );
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^td_switch:(\d+)$/, async (ctx) => {
    const listId = parseInt(ctx.match[1]);
    stmtSetActiveTodoList.run(ctx.from.id, ctx.chat!.id, listId);
    await renderMain(ctx.api, ctx.chat!.id, ctx.from.id, ctx.callbackQuery.message!.message_id);
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^td_dellist:(\d+)$/, async (ctx) => {
    const chatId = ctx.chat!.id;
    const listId = parseInt(ctx.match[1]);
    const lists = stmtGetUserTodoLists.all(chatId, ctx.from.id) as TodoList[];
    if (lists.length <= 1)
      return ctx.answerCallbackQuery({ text: 'Нельзя удалить последний список!', show_alert: true });

    stmtDeleteTodoListItems.run(listId);
    stmtDeleteTodoList.run(listId, ctx.from.id);

    const activeRow = stmtGetActiveTodoListId.get(ctx.from.id, chatId) as { list_id: number } | undefined;
    if (!activeRow || activeRow.list_id === listId) {
      const remaining = stmtGetUserTodoLists.all(chatId, ctx.from.id) as TodoList[];
      if (remaining.length > 0) stmtSetActiveTodoList.run(ctx.from.id, chatId, remaining[0].id);
    }

    const newActiveId = ensureActiveList(ctx.from.id, chatId);
    const updatedLists = stmtGetUserTodoLists.all(chatId, ctx.from.id) as TodoList[];
    await ctx.api.editMessageText(chatId, ctx.callbackQuery.message!.message_id,
      buildListsText(updatedLists, newActiveId),
      { parse_mode: 'HTML', reply_markup: buildListsKeyboard(updatedLists, newActiveId) }
    );
    return ctx.answerCallbackQuery({ text: '🗑 Список удалён' });
  });

  bot.callbackQuery('td_newlist', async (ctx) => {
    const chatId = ctx.chat!.id;
    const msgId = ctx.callbackQuery.message!.message_id;
    userTodoStates.set(ctx.from.id, { action: 'new_list', chatId, userId: ctx.from.id, msgId });
    await ctx.api.editMessageText(chatId, msgId,
      '📋 <b>Новый список</b>\n\nНапиши название:',
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('✕ Отмена', 'td_cancel') }
    );
    return ctx.answerCallbackQuery();
  });

  bot.callbackQuery('td_back', async (ctx) => {
    await renderMain(ctx.api, ctx.chat!.id, ctx.from.id, ctx.callbackQuery.message!.message_id);
    return ctx.answerCallbackQuery();
  });
}
