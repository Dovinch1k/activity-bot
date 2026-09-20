import { Guild, PermissionFlagsBits, TextChannel, EmbedBuilder } from 'discord.js';
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

    // 5. Проверяем, может ли бот технически кикнуть этого участника (иерархия ролей)
    if (!member.kickable) {
      result.notKickable++;
      continue;
    }

    // 6. Определяем время последней активности
    const activity = activities.get(member.id);
    let lastActiveTimestamp: number;
    let lastActionType: string | null = null;

    if (activity) {
      lastActiveTimestamp = activity.last_active_at;
      lastActionType = activity.last_action_type;
    } else {
      // Если записи в БД нет, проверяем дату вступления на сервер
      const joinedAt = member.joinedTimestamp || now;
      const timeSinceJoined = now - joinedAt;

      // Если пользователь зашел на сервер менее 30 дней назад — даем льготный период
      if (timeSinceJoined < config.inactivityMs) {
        result.activeMembers++;
        continue;
      }

      // Если пользователь находится на сервере > 30 дней и ни разу не писал и не заходил в войс
      lastActiveTimestamp = joinedAt;
      lastActionType = 'no_activity_since_join';
    }

    const inactiveMs = now - lastActiveTimestamp;

    if (inactiveMs >= config.inactivityMs) {
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
 * Отправка отчета о проверке в специальный канал логов Discord (если настроен)
 */
async function sendLogReport(guild: Guild, result: InactivityCheckResult): Promise<void> {
  if (!config.logChannelId) {
    return;
  }

  try {
    const channel = await guild.channels.fetch(config.logChannelId);
    if (!channel || !(channel instanceof TextChannel)) {
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 Отчет о проверке активности (${result.isDryRun ? 'Тестовый режим' : 'Боевой режим'})`)
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
