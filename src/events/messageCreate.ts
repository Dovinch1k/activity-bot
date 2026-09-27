import { Message } from 'discord.js';
import { activityRepo } from '../db/repository.js';

export async function handleMessageCreate(message: Message): Promise<void> {
  // ОБЯЗАТЕЛЬНО: Полностью игнорируем ботов (по флагу Discord или роли ботов)
  if (message.author.bot || message.member?.roles.cache.has('1447298867963105451')) {
    return;
  }

  // Игнорируем личные сообщения (DMs), учитываем только серверы
  if (!message.guild) {
    return;
  }

  try {
    activityRepo.recordActivity(message.guild.id, message.author.id, 'message');
  } catch (error) {
    console.error(`[Message Event] Ошибка при сохранении активности пользователя ${message.author.id}:`, error);
  }
}
