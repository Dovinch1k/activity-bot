import { VoiceState } from 'discord.js';
import { activityRepo } from '../db/repository.js';

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  const member = newState.member;

  // ОБЯЗАТЕЛЬНО: Полностью игнорируем ботов
  if (!member || member.user.bot) {
    return;
  }

  const guild = newState.guild;
  if (!guild) {
    return;
  }

  // Проверяем: это вход в голосовой канал или переключение между голосовыми каналами
  const joinedChannel = !oldState.channelId && !!newState.channelId;
  const switchedChannel = !!oldState.channelId && !!newState.channelId && oldState.channelId !== newState.channelId;

  if (joinedChannel || switchedChannel) {
    try {
      activityRepo.recordActivity(guild.id, member.id, 'voice');
    } catch (error) {
      console.error(`[Voice Event] Ошибка при сохранении активности пользователя ${member.id}:`, error);
    }
  }
}
