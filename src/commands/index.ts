import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  Client,
  REST,
  Routes,
} from 'discord.js';
import { checkGuildInactivity, scanGuildHistory } from '../services/inactivityChecker.js';
import { activityRepo } from '../db/repository.js';
import { config } from '../config.js';

export const slashCommands = [
  new SlashCommandBuilder()
    .setName('check-inactivity')
    .setDescription('Проверить участников на неактивность 30+ дней')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption(option =>
      option
        .setName('dry_run')
        .setDescription('Тестовый режим (true = только отчет без кика, false = реальный кик)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('activity-info')
    .setDescription('Показать статус активности конкретного участника')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Участник для проверки')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('scan-history')
    .setDescription('Просканировать историю сообщений в каналах и обновить активность')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('mark-all-active')
    .setDescription('Сбросить таймер и пометить всех текущих участников активными от сегодняшнего дня')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

export async function registerCommands(client: Client): Promise<void> {
  if (!config.discordToken) return;

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  try {
    const clientId = client.user?.id || config.clientId;
    if (!clientId) {
      console.warn('[Commands] Не указан CLIENT_ID, регистрация слэш-команд отложена.');
      return;
    }

    const commandData = slashCommands.map(cmd => cmd.toJSON());

    if (config.guildId) {
      console.log(`[Commands] Регистрируем слэш-команды для тестового сервера ${config.guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, config.guildId), {
        body: commandData,
      });
    } else {
      console.log('[Commands] Регистрируем глобальные слэш-команды...');
      await rest.put(Routes.applicationCommands(clientId), {
        body: commandData,
      });
    }

    console.log('[Commands] Слэш-команды успешно зарегистрированы!');
  } catch (error) {
    console.error('[Commands] Ошибка при регистрации слэш-команд:', error);
  }
}

export async function handleInteractionCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: 'Эта команда доступна только на сервере.', ephemeral: true });
    return;
  }

  // 1. Команда /check-inactivity
  if (interaction.commandName === 'check-inactivity') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'У вас нет прав администратора для запуска этой команды.', ephemeral: true });
      return;
    }

    const dryRun = interaction.options.getBoolean('dry_run') ?? true;
    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await checkGuildInactivity(interaction.guild, { dryRun });

      const embed = new EmbedBuilder()
        .setTitle(`Отчет проверки неактивности (${result.isDryRun ? 'Тестовый режим (без кика)' : 'Боевой режим (кик выполнен)'})`)
        .setColor(result.isDryRun ? 0x00bfff : 0xff3333)
        .addFields(
          { name: '👥 Всего участников', value: `${result.totalMembers}`, inline: true },
          { name: '✅ Активных', value: `${result.activeMembers}`, inline: true },
          { name: '🤖 Игнорируемых ботов', value: `${result.botsIgnored}`, inline: true },
          { name: '🛡️ Иммунных (админы/роли)', value: `${result.immuneSkipped}`, inline: true },
          { name: '⚠️ Выше роли бота', value: `${result.notKickable}`, inline: true },
          { name: result.isDryRun ? '🔍 Кандидатов на кик' : '🚪 Кикнуто участников', value: `${result.isDryRun ? result.candidates.length : result.kickedCount}`, inline: true }
        )
        .setTimestamp();

      if (result.candidates.length > 0) {
        const topList = result.candidates
          .slice(0, 10)
          .map((c, i) => `${i + 1}. **${c.userTag}** — неактивен **${c.daysInactive}** дн.`)
          .join('\n');

        embed.addFields({
          name: `Список кандидатов (${result.candidates.length > 10 ? 'первые 10 из ' + result.candidates.length : result.candidates.length}):`,
          value: topList,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('[Command Error]', error);
      await interaction.editReply({ content: `Произошла ошибка при выполнении: ${error instanceof Error ? error.message : String(error)}` });
    }
    return;
  }

  // 2. Команда /activity-info
  if (interaction.commandName === 'activity-info') {
    const targetUser = interaction.options.getUser('user', true);
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      await interaction.reply({ content: 'Пользователь не найден на сервере.', ephemeral: true });
      return;
    }

    if (member.user.bot) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`Информация об активности: ${member.user.tag}`)
            .setColor(0x808080)
            .setDescription('🤖 **Этот пользователь является ботом.** Боты полностью игнорируются системой кика.')
        ],
        ephemeral: true,
      });
      return;
    }

    const activity = activityRepo.getUserActivity(interaction.guild.id, member.id);
    const installedAt = activityRepo.getGuildInstalledAt(interaction.guild.id);
    const now = Date.now();
    const joinedAt = member.joinedTimestamp || now;

    let lastActiveAt: number;
    let actionDesc: string;

    if (activity) {
      lastActiveAt = activity.last_active_at;
      actionDesc = activity.last_action_type === 'message' ? 'Отправка сообщения' : 'Вход в голосовой канал';
    } else {
      lastActiveAt = Math.max(joinedAt, installedAt);
      actionDesc = 'Точка отсчета: дата добавления бота на сервер';
    }

    const daysInactive = Math.floor((now - lastActiveAt) / (24 * 60 * 60 * 1000));
    const daysUntilKick = Math.max(0, config.inactivityDays - daysInactive);
    const isAtRisk = daysInactive >= config.inactivityDays;

    const embed = new EmbedBuilder()
      .setTitle(`Информация об активности: ${member.user.tag}`)
      .setColor(isAtRisk ? 0xff0000 : 0x00ff00)
      .addFields(
        { name: '📅 Дата входа на сервер', value: `<t:${Math.floor(joinedAt / 1000)}:R>`, inline: true },
        { name: '🕒 Последняя активность', value: `<t:${Math.floor(lastActiveAt / 1000)}:R>`, inline: true },
        { name: '🎯 Тип активности', value: actionDesc, inline: true },
        { name: '⏳ Дней неактивен', value: `**${daysInactive}** из ${config.inactivityDays}`, inline: true },
        { name: 'Статус', value: isAtRisk ? '🚨 **Подлежит кику за неактивность!**' : `✅ Активен (до порога кика: ~${daysUntilKick} дн.)`, inline: true }
      )
      .setThumbnail(member.user.displayAvatarURL());

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // 3. Команда /scan-history
  if (interaction.commandName === 'scan-history') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'У вас нет прав администратора для запуска этой команды.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const scanRes = await scanGuildHistory(interaction.guild);
      await interaction.editReply({
        content: `🔍 **Сканирование завершено!**\nПроверено каналов: **${scanRes.channelsScanned}**\nНайдено сообщений: **${scanRes.messagesFound}**\nОбновлена активность для **${scanRes.usersUpdated}** участников.`,
      });
    } catch (err) {
      await interaction.editReply({ content: `Ошибка сканирования: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }

  // 4. Команда /mark-all-active
  if (interaction.commandName === 'mark-all-active') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: 'У вас нет прав администратора для запуска этой команды.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    try {
      const members = await interaction.guild.members.fetch();
      const userIds = members.filter(m => !m.user.bot).map(m => m.id);
      activityRepo.markAllActive(interaction.guild.id, userIds);
      await interaction.editReply({
        content: `✅ **Все участники (${userIds.length} чел.) успешно помечены активными!**\nТеперь у каждого из них есть 30 дней с сегодняшнего дня для отправки сообщений или входа в войс.`,
      });
    } catch (err) {
      await interaction.editReply({ content: `Ошибка: ${err instanceof Error ? err.message : String(err)}` });
    }
    return;
  }
}
