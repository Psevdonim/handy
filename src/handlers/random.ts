import { Context } from 'grammy';

export async function handleRandom(ctx: Context): Promise<void> {
  const options = (ctx.match as string).trim().split(/\s+/).filter(Boolean);

  if (options.length === 0) {
    await ctx.reply('Укажи варианты: /random kek lul wow heh');
    return;
  }

  const pick = options[Math.floor(Math.random() * options.length)];
  await ctx.reply(`🎲 ${pick}`);
}
