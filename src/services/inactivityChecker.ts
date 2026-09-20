import { Guild, PermissionFlagsBits, TextChannel, EmbedBuilder, ChannelType } from 'discord.js';
import { config } from '../config.js';
import { activityRepo } from '../db/repository.js';

export interface InactivityCandidate {
  userId: string;
  userTag: string;
  daysInactive: number;
  lastActionType: string | null;
  joinedAt: Date | null;
  reason: string;
}

export interface InactivityCheckResult {
  guildId: string;
  guildName: string;
  totalMembers: number;
  botsIgnored: number;
  immuneSkipped: number;
  notKickable: number;
  activeMembers: number;
  candidates: InactivityCandidate[];
  kickedCount: number;
  failedKicks: Array<{ userId: string; userTag: string; error: string }>;
  isDryRun: boolean;
}

/**
 * Выполняет проверку всех участников гильдии и кикает тех, кто неактивен более 30 дней.
 */
export async function checkGuildInactivity(guild: Guild, options?: { dryRun?: boolean }): Promise<InactivityCheckResult> {
  const isDryRun = options?.dryRun !== undefined ? options.dryRun : config.dryRun;
  const now = Date.now();

  console.log(`[Inactivity Checker] Начинаем проверку для сервера "${guild.name}" (${guild.id}) | Режим: ${isDryRun ? 'ТЕСТОВЫЙ (DRY_RUN)' : 'РЕАЛЬНЫЙ КИК'}`);

  // Загружаем всех участников гильдии
  const members = await guild.members.fetch();
  const activities = activityRepo.getAllGuildActivities(guild.id);
  const installedAt = activityRepo.getGuildInstalledAt(guild.id);

  const result: InactivityCheckResult = {
    guildId: guild.id,
    guildName: guild.name,
    totalMembers: members.size,
    botsIgnored: 0,
    immuneSkipped: 0,
    notKickable: 0,
    activeMembers: 0,
    candidates: [],
    kickedCount: 0,
    failedKicks: [],
    isDryRun,
  };

  for (const [, member] of members) {
    // 1. ОБЯЗАТЕЛЬНО: Игнорируем ботов
    if (member.user.bot) {
      result.botsIgnored++;
      continue;
    }

    // 2. Игнорируем владельца сервера (Discord API не позволит его кикнуть)
    if (member.id === guild.ownerId) {
      result.immuneSkipped++;
      continue;
    }

    // 3. Игнорируем администраторов
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
      result.immuneSkipped++;
      continue;
    }

    // 4. Игнорируем иммунные роли из конфигурации
    const hasImmuneRole = config.immuneRoleIds.some(roleId => member.roles.cache.has(roleId));
    if (hasImmuneRole) {
      result.immuneSkipped++;
      continue;
    }

    // 5. Определяем время последней активности
    const activity = activities.get(member.id);
    let lastActiveTimestamp: number;
    let lastActionType: string | null = null;

    if (activity) {
      lastActiveTimestamp = activity.last_active_at;
      lastActionType = activity.last_action_type;
    } else {
      // Если записи в БД еще нет (бот только добавлен):
      // Точкой отсчета является дата добавления бота либо дата захода участника на сервер (что позже).
      // Таким образом, все существующие участники получают 30 дней активности с момента добавления бота!
      const joinedAt = member.joinedTimestamp || now;
      lastActiveTimestamp = Math.max(joinedAt, installedAt);
      lastActionType = 'baseline';
    }

    const inactiveMs = now - lastActiveTimestamp;

    if (inactiveMs >= config.inactivityMs) {
      // Проверяем, может ли бот технически кикнуть этого участника (иерархия ролей)
      if (!member.kickable) {
        result.notKickable++;
        continue;
      }

      const daysInactive = Math.floor(inactiveMs / (24 * 60 * 60 * 1000));
      const reason = `Неактивен ${daysInactive} дн. (нет сообщений и заходов в войс)`;

      const candidate: InactivityCandidate = {
        userId: member.id,
        userTag: member.user.tag,
        daysInactive,
        lastActionType,
        joinedAt: member.joinedAt,
        reason,
      };

      result.candidates.push(candidate);

      if (!isDryRun) {
        try {
          await member.kick(reason);
          activityRepo.deleteUser(guild.id, member.id);
          result.kickedCount++;
          console.log(`[Kick] Кикнут: ${member.user.tag} (${member.id}) — ${reason}`);
          await logKickEvent(guild, member.user.tag, member.id, daysInactive, reason);
        } catch (error) {
          console.error(`[Kick Error] Не удалось кикнуть ${member.user.tag}:`, error);
          result.failedKicks.push({
            userId: member.id,
            userTag: member.user.tag,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        console.log(`[DRY RUN] Был бы кикнут: ${member.user.tag} (${member.id}) — ${reason}`);
      }
    } else {
      result.activeMembers++;
    }
  }

  // Отправляем лог в канал, если задан LOG_CHANNEL_ID
  await sendLogReport(guild, result);

  return result;
}

/**
 * Сканирует последние сообщения в текстовых каналах сервера для заполнения активности
 */
export async function scanGuildHistory(guild: Guild, limitPerChannel: number = 100): Promise<{ channelsScanned: number; messagesFound: number; usersUpdated: number }> {
  console.log(`[History Scanner] Сканирование истории сообщений на сервере "${guild.name}"...`);
  const channels = await guild.channels.fetch();
  let channelsScanned = 0;
  let messagesFound = 0;
  const updatedUserIds = new Set<string>();

  for (const [, channel] of channels) {
    if (!channel || channel.type !== ChannelType.GuildText || !channel.viewable) {
      continue;
    }

    try {
      channelsScanned++;
      const messages = await (channel as TextChannel).messages.fetch({ limit: limitPerChannel });
      for (const [, message] of messages) {
        if (message.author.bot) continue;
        messagesFound++;
        activityRepo.recordActivityIfNewer(guild.id, message.author.id, 'message', message.createdTimestamp);
        updatedUserIds.add(message.author.id);
      }
    } catch (err) {
      console.warn(`[History Scanner] Не удалось прочитать сообщения в канале #${channel.name}:`, err);
    }
  }

  console.log(`[History Scanner] Завершено. Просканировано каналов: ${channelsScanned}, сообщений: ${messagesFound}, обновлено участников: ${updatedUserIds.size}`);
  return {
    channelsScanned,
    messagesFound,
    usersUpdated: updatedUserIds.size,
  };
}

/**
 * Отправка отчета о проверке в специальный канал логов Discord (если настроен)
 */
export async function sendLogReport(guild: Guild, result: InactivityCheckResult): Promise<void> {
  const logChannelId = activityRepo.getGuildLogChannel(guild.id) || config.logChannelId;
  if (!logChannelId) {
    return;
  }

  try {
    const channel = await guild.channels.fetch(logChannelId);
    if (!channel || !(channel instanceof TextChannel)) {
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 Отчет о проверке активности (${result.isDryRun ? 'Тестовый режим (без кика)' : 'Боевой режим (кик выполнен)'})`)
      .setColor(result.isDryRun ? 0xffa500 : 0xff0000)
      .setDescription(
        `**Всего участников:** ${result.totalMembers}\n` +
        `**Активных:** ${result.activeMembers}\n` +
        `**Игнорируемых ботов:** ${result.botsIgnored}\n` +
        `**Админов/Иммунных:** ${result.immuneSkipped}\n` +
        `**Нельзя кикнуть (роль выше бота):** ${result.notKickable}\n` +
        `**Кандидатов на кик (≥ ${config.inactivityDays} дн.):** ${result.candidates.length}\n` +
        `**Фактически кикнуто:** ${result.isDryRun ? 0 : result.kickedCount}`
      )
      .setTimestamp();

    if (result.candidates.length > 0) {
      const candidateList = result.candidates
        .slice(0, 15)
        .map(c => `• **${c.userTag}**: неактивен ${c.daysInactive} дн.`)
        .join('\n');

      embed.addFields({
        name: `Кандидаты (${result.candidates.length > 15 ? 'первые 15' : result.candidates.length})`,
        value: candidateList,
      });
    }

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('[Log Report Error] Не удалось отправить отчет в канал:', error);
  }
}

/**
 * Отправка лога об исключении конкретного участника в канал логов
 */
export async function logKickEvent(guild: Guild, userTag: string, userId: string, daysInactive: number, reason: string): Promise<void> {
  const logChannelId = activityRepo.getGuildLogChannel(guild.id) || config.logChannelId;
  if (!logChannelId) {
    return;
  }

  try {
    const channel = await guild.channels.fetch(logChannelId);
    if (!channel || !(channel instanceof TextChannel)) {
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('👢 Участник исключен за неактивность')
      .setColor(0xff0000)
      .addFields(
        { name: 'Участник', value: `**${userTag}** (<@${userId}>)`, inline: true },
        { name: 'ID', value: `\`${userId}\``, inline: true },
        { name: 'Неактивен', value: `**${daysInactive}** дн.`, inline: true },
        { name: 'Причина', value: reason, inline: false }
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('[Kick Log Error] Не удалось отправить лог кика в канал:', error);
  }
}
