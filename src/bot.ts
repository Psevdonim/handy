import 'dotenv/config';
import { Bot } from 'grammy';
import { handleBirthday } from './handlers/birthday';
import { handleMemeMessage, handleReaction, handleReactionCount, handleSetMemeChannel } from './handlers/memes';
import { handleWeather } from './handlers/weather';
import { handleRandom } from './handlers/random';
import { handleDickyGame, setupGameCallbacks } from './handlers/dicky-game';
import { handleGay, handleGayInlineQuery, handleGayRating } from './handlers/gay';
import { handleTodo, handleTodoTextInput, setupTodoCallbacks } from './handlers/todo';
import { setupScheduler } from './scheduler';
import logger from './logger';

const token = process.env.BOT_TOKEN;
if (!token) throw new Error('BOT_TOKEN is not set in .env');

const bot = new Bot(token);

// Commands
bot.command('birthday', handleBirthday);
bot.command('setmemechannel', handleSetMemeChannel);
bot.command('weather', handleWeather);
bot.command('random', handleRandom);
bot.command('dicky', handleDickyGame);
bot.command('how_many_im_gay', handleGay);
bot.command('gay_rating', handleGayRating);
bot.command('todo', handleTodo);

setupGameCallbacks(bot);
setupTodoCallbacks(bot);

// Todo text input (add item / new list name)
bot.on('message:text', handleTodoTextInput);

// Track media posts as potential memes
bot.on([':photo', ':video'], handleMemeMessage);

// Track reactions
bot.on('message_reaction', handleReaction);
bot.on('message_reaction_count', handleReactionCount);

// Inline query for gay result sharing
bot.on('inline_query', handleGayInlineQuery);

bot.catch((err) => {
  logger.error('[bot error]', err);
});

setupScheduler(bot);

bot.api.setMyCommands([
  { command: 'birthday',        description: 'Дни рождения — set/list/delete/test' },
  { command: 'weather',         description: 'Погода в городах — add/remove/list' },
  { command: 'random',          description: 'Случайный выбор из вариантов' },
  { command: 'dicky',           description: 'Игра в см — roll/raise/top/config' },
  { command: 'how_many_im_gay', description: 'Насколько ты гей сегодня?' },
  { command: 'gay_rating',      description: 'Рейтинг гейства по реакциям' },
  { command: 'todo',           description: 'Список задач' },
]).catch((e) => logger.error('[setMyCommands]', e));

bot.start({
  allowed_updates: [
    'message',
    'channel_post',
    'callback_query',
    'message_reaction',
    'message_reaction_count',
    'inline_query',
  ],
});

logger.info('Bot is running...');
