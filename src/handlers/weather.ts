import { Context } from 'grammy';
import { stmtAddCity, stmtFindCity, stmtRemoveCity, stmtGetCities } from '../database';

const BASE = 'https://wttr.in';

interface WeatherData {
  city: string;
  tempC: number;
  temp: string;
  feels: string;
  humidity: string;
  uvIndex: string;
}

async function fetchWeather(city: string): Promise<WeatherData | string> {
  const url = `${BASE}/${encodeURIComponent(city)}?format=j1`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return `❌ Нет соединения с сервером погоды`;
  }

  if(!res.ok) {
      let text = ``
      
      try {
        text = await res.text()
      } catch (error) {
        return `❌ Произошло что-то совсем плохое (HTTP ${res.status})`;
      }
      
      if (text.includes('location not found')) return `❌ Город «${city}» не найден`;
      
      return `❌ Ошибка сервера (HTTP ${res.status})`;
  }

  const d = await res.json() as any;
  const c = d.current_condition[0];

  return {
    city,
    tempC: parseInt(c.temp_C),
    temp: `${c.temp_C}°C`,
    feels: `${c.FeelsLikeC}°C`,
    humidity: `${c.humidity}%`,
    uvIndex: c.uvIndex ?? '—',
  };
}

function formatWeather(rows: WeatherData[]): string {
  return rows.map(r =>
    `📍 *${r.city[0].toUpperCase()}${r.city.slice(1)}* \t — 🌡 ${r.temp} (${r.feels}) · 💧 ${r.humidity} · ☀️ УФ ${r.uvIndex}`
  ).join('\n');
}

export async function handleWeather(ctx: Context): Promise<void> {
  const chat = ctx.chat;
  if (!chat) return;

  const parts = (ctx.match as string).trim().split(/\s+/);
  const sub = parts[0];

  if (!sub) {
    const rows = stmtGetCities.all(chat.id) as { city: string }[];
    if (rows.length === 0) {
      await ctx.reply('Список городов пуст. Добавь: /weather add <город>');
      return;
    }
    const results = await Promise.all(rows.map(r => fetchWeather(r.city)));
    const errors = results.filter((r): r is string => typeof r === 'string');
    const data   = results.filter((r): r is WeatherData => typeof r === 'object')
                          .sort((a, b) => b.tempC - a.tempC);

    let reply = '';
    if (data.length > 0) reply += formatWeather(data);
    if (errors.length > 0) reply += '\n' + errors.join('\n');

    await ctx.reply(reply.trim(), { parse_mode: 'Markdown' });
    return;
  }

  if (sub === 'add') {
    const city = parts.slice(1).join(' ');
    if (!city) {
      await ctx.reply('Укажи название: /weather add Москва');
      return;
    }

    const check = await fetchWeather(city);
    if (typeof check === 'string') {
      await ctx.reply(check);
      return;
    }
    stmtAddCity.run(chat.id, city);
    await ctx.reply(`✅ Город «${check.city}» добавлен в список.`);
    return;
  }

  if (sub === 'remove') {
    const cities = parts.slice(1).filter(Boolean);
    if (cities.length === 0) {
      await ctx.reply('Укажи название: /weather remove Москва Питер');
      return;
    }
    const removed: string[] = [];
    const notFound: string[] = [];
    for (const city of cities) {
      const key = city.toLowerCase();
      const found = stmtFindCity.get(chat.id, key) as { city: string } | undefined;
      if (!found) { notFound.push(city); continue; }
      stmtRemoveCity.run(chat.id, key);
      removed.push(found.city);
    }
    const lines: string[] = [];
    if (removed.length > 0) lines.push(`🗑 Удалено: ${removed.map(c => `«${c}»`).join(', ')}`);
    if (notFound.length > 0) lines.push(`❌ Город для удаления не найден: ${notFound.map(c => `«${c}»`).join(', ')}`);
    await ctx.reply(lines.join('\n'));
    return;
  }

  if (sub === 'list') {
    const rows = stmtGetCities.all(chat.id) as { city: string }[];
    if (rows.length === 0) {
      await ctx.reply('Список городов пуст.');
      return;
    }
    await ctx.reply('📋 Города:\n' + rows.map(r => `• ${r.city}`).join('\n'));
    return;
  }

  await ctx.reply(
    'Команды погоды:\n' +
    '/weather — показать погоду для всех городов\n' +
    '/weather add <город> — добавить город\n' +
    '/weather remove <город> — удалить город\n' +
    '/weather list — список городов'
  );
}
