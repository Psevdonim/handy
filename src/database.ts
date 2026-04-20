import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const db = new Database(process.env.DATABASE_PATH || 'bot.db');
db.pragma('journal_mode = WAL');

// Migrate gay_scores: drop old per-chat schema if it exists
const gayScolumns = db.prepare("PRAGMA table_info(gay_scores)").all() as { name: string }[];
if (gayScolumns.some(c => c.name === 'chat_id')) {
  db.exec('DROP TABLE gay_scores');
}

// Migrate todo_lists/todo_active: add chat_id if missing
// Migrate birthdays: add is_external column if missing
const birthdayCols = db.prepare("PRAGMA table_info(birthdays)").all() as { name: string }[];
if (birthdayCols.length > 0 && !birthdayCols.some(c => c.name === 'is_external')) {
  db.exec("ALTER TABLE birthdays ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0");
}

const todoListCols = db.prepare("PRAGMA table_info(todo_lists)").all() as { name: string }[];
if (todoListCols.length > 0 && !todoListCols.some(c => c.name === 'chat_id')) {
  db.exec('DROP TABLE IF EXISTS todo_active; DROP TABLE IF EXISTS todo_items; DROP TABLE IF EXISTS todo_lists;');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS birthdays (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    username    TEXT,
    first_name  TEXT NOT NULL,
    day         INTEGER NOT NULL,
    month       INTEGER NOT NULL,
    UNIQUE(chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS memes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id        INTEGER NOT NULL,
    message_id     INTEGER NOT NULL,
    user_id        INTEGER NOT NULL,
    posted_at      INTEGER NOT NULL,
    reaction_count INTEGER NOT NULL DEFAULT 0,
    forwarded      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(chat_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id         INTEGER PRIMARY KEY,
    meme_channel_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS cities (
    chat_id INTEGER NOT NULL,
    city    TEXT    NOT NULL,
    PRIMARY KEY (chat_id, city)
  );

  CREATE TABLE IF NOT EXISTS gay_scores (
    user_id INTEGER PRIMARY KEY,
    value   REAL    NOT NULL,
    date    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS game_players (
    chat_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    username   TEXT,
    first_name TEXT    NOT NULL,
    value      REAL    NOT NULL DEFAULT 10.0,
    last_roll  INTEGER,
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS game_config (
    chat_id    INTEGER PRIMARY KEY,
    start_wait INTEGER NOT NULL DEFAULT 300,
    join_wait  INTEGER NOT NULL DEFAULT 20
  );

  CREATE TABLE IF NOT EXISTS todo_lists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS todo_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id    INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS todo_active (
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    list_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id)
  );

`);


export interface BirthdayRow {
  chat_id: number;
  user_id: number;
  username: string | null;
  first_name: string;
  day: number;
  month: number;
  is_external: number;
}

export interface MemeRow {
  id: number;
  message_id: number;
  reaction_count: number;
}

export interface ChatSettingsRow {
  chat_id: number;
  meme_channel_id: number;
}

// ── Birthdays ──────────────────────────────────────────────────────────────

export const stmtSetBirthday = db.prepare(`
  INSERT INTO birthdays (chat_id, user_id, username, first_name, day, month, is_external)
  VALUES (@chat_id, @user_id, @username, @first_name, @day, @month, @is_external)
  ON CONFLICT(chat_id, user_id) DO UPDATE SET
    username    = excluded.username,
    first_name  = excluded.first_name,
    day         = excluded.day,
    month       = excluded.month,
    is_external = excluded.is_external
`);

export const stmtDeleteBirthday = db.prepare(
  'DELETE FROM birthdays WHERE chat_id = ? AND user_id = ?'
);

export const stmtDeleteExternalBirthday = db.prepare(
  'DELETE FROM birthdays WHERE chat_id = ? AND is_external = 1 AND (username = ? OR first_name = ?)'
);

export const stmtGetBirthdaysToday = db.prepare(
  'SELECT chat_id, user_id, username, first_name, is_external FROM birthdays WHERE day = ? AND month = ?'
);

export const stmtGetChatBirthdays = db.prepare(
  'SELECT user_id, username, first_name, day, month, is_external FROM birthdays WHERE chat_id = ? ORDER BY month, day'
);

// ── Memes ──────────────────────────────────────────────────────────────────

export const stmtAddMeme = db.prepare(`
  INSERT OR IGNORE INTO memes (chat_id, message_id, user_id, posted_at)
  VALUES (?, ?, ?, ?)
`);

export const stmtSetReactionCount = db.prepare(
  'UPDATE memes SET reaction_count = ? WHERE chat_id = ? AND message_id = ?'
);

export const stmtDeltaReactionCount = db.prepare(
  'UPDATE memes SET reaction_count = MAX(0, reaction_count + ?) WHERE chat_id = ? AND message_id = ?'
);

export const stmtGetPendingMemes = db.prepare(
  'SELECT id, message_id, reaction_count FROM memes WHERE chat_id = ? AND forwarded = 0 AND posted_at <= ?'
);

export const stmtMarkMeme = db.prepare(
  'UPDATE memes SET forwarded = ? WHERE id = ?'
);

export const stmtGetReactionRanking = db.prepare(`
  SELECT user_id, SUM(reaction_count) as total_reactions
  FROM memes
  WHERE chat_id = ?
  GROUP BY user_id
  ORDER BY total_reactions DESC
  LIMIT 20
`);

// ── Chat settings ──────────────────────────────────────────────────────────

export const stmtSetMemeChannel = db.prepare(`
  INSERT INTO chat_settings (chat_id, meme_channel_id)
  VALUES (?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET meme_channel_id = excluded.meme_channel_id
`);

export const stmtGetMemeChannel = db.prepare(
  'SELECT meme_channel_id FROM chat_settings WHERE chat_id = ?'
);

export const stmtGetChatsWithChannel = db.prepare(
  'SELECT chat_id, meme_channel_id FROM chat_settings WHERE meme_channel_id IS NOT NULL'
);

// ── Cities ─────────────────────────────────────────────────────────────────

export const stmtAddCity = db.prepare(
  'INSERT OR IGNORE INTO cities (chat_id, city) VALUES (?, ?)'
);

export const stmtFindCity = db.prepare(
  'SELECT city FROM cities WHERE chat_id = ? AND LOWER(city) = ?'
);

export const stmtRemoveCity = db.prepare(
  'DELETE FROM cities WHERE chat_id = ? AND LOWER(city) = ?'
);

export const stmtGetCities = db.prepare(
  'SELECT city FROM cities WHERE chat_id = ? ORDER BY city'
);

// ── Game ───────────────────────────────────────────────────────────────────

export interface PlayerRow {
  value: number;
  last_roll: number | null;
}

export const stmtGetPlayer = db.prepare(
  'SELECT value, last_roll FROM game_players WHERE chat_id = ? AND user_id = ?'
);

export const stmtUpsertPlayer = db.prepare(`
  INSERT OR IGNORE INTO game_players (chat_id, user_id, username, first_name, value)
  VALUES (?, ?, ?, ?, 10.0)
`);

export const stmtUpdatePlayerValue = db.prepare(
  'UPDATE game_players SET value = ?, username = ?, first_name = ? WHERE chat_id = ? AND user_id = ?'
);

export const stmtSetPlayerValue = db.prepare(
  'UPDATE game_players SET value = ? WHERE chat_id = ? AND user_id = ?'
);

export const stmtUpdateLastRoll = db.prepare(
  'UPDATE game_players SET last_roll = ? WHERE chat_id = ? AND user_id = ?'
);

export const stmtGetTopPlayers = db.prepare(
  'SELECT username, first_name, value FROM game_players WHERE chat_id = ? ORDER BY value DESC LIMIT 10'
);

// ── Gay scores ─────────────────────────────────────────────────────────────

export const stmtGetGayScore = db.prepare(
  'SELECT value, date FROM gay_scores WHERE user_id = ?'
);

export const stmtUpsertGayScore = db.prepare(`
  INSERT INTO gay_scores (user_id, value, date) VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET value = excluded.value, date = excluded.date
`);

// ── Game config ────────────────────────────────────────────────────────────

export const stmtGetGameConfig = db.prepare(
  'SELECT start_wait, join_wait FROM game_config WHERE chat_id = ?'
);

export const stmtUpsertGameConfig = db.prepare(`
  INSERT INTO game_config (chat_id, start_wait, join_wait)
  VALUES (@chat_id, @start_wait, @join_wait)
  ON CONFLICT(chat_id) DO UPDATE SET
    start_wait = excluded.start_wait,
    join_wait  = excluded.join_wait
`);

// ── Todo ───────────────────────────────────────────────────────────────────

export const stmtCreateTodoList = db.prepare(
  'INSERT INTO todo_lists (chat_id, user_id, name) VALUES (?, ?, ?)'
);

export const stmtGetUserTodoLists = db.prepare(
  'SELECT id, name FROM todo_lists WHERE chat_id = ? AND user_id = ? ORDER BY created_at'
);

export const stmtGetTodoList = db.prepare(
  'SELECT id, name FROM todo_lists WHERE id = ?'
);

export const stmtDeleteTodoListItems = db.prepare(
  'DELETE FROM todo_items WHERE list_id = ?'
);

export const stmtDeleteTodoList = db.prepare(
  'DELETE FROM todo_lists WHERE id = ? AND user_id = ?'
);

export const stmtGetActiveTodoListId = db.prepare(
  'SELECT list_id FROM todo_active WHERE user_id = ? AND chat_id = ?'
);

export const stmtSetActiveTodoList = db.prepare(`
  INSERT INTO todo_active (user_id, chat_id, list_id) VALUES (?, ?, ?)
  ON CONFLICT(user_id, chat_id) DO UPDATE SET list_id = excluded.list_id
`);

export const stmtGetTodoItems = db.prepare(
  'SELECT id, text, done FROM todo_items WHERE list_id = ? ORDER BY created_at'
);

export const stmtAddTodoItem = db.prepare(
  'INSERT INTO todo_items (list_id, text) VALUES (?, ?)'
);

export const stmtToggleTodoItem = db.prepare(
  'UPDATE todo_items SET done = 1 - done WHERE id = ?'
);

export const stmtDeleteTodoItem = db.prepare(
  'DELETE FROM todo_items WHERE id = ?'
);

export default db;
