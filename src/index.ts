import {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
} from 'discord.js';
import { config } from './config.js';
import { handleMessageCreate } from './events/messageCreate.js';
import { handleVoiceStateUpdate } from './events/voiceStateUpdate.js';
import { handleInteractionCreate, registerCommands } from './commands/index.js';
import { checkGuildInactivity } from './services/inactivityChecker.js';
import { startHealthServer } from './server.js';
import { activityRepo } from './db/repository.js';

if (!config.discordToken) {
  console.error('❌ ОШИБКА: Токен Discord не задан в переменных окружения (DISCORD_TOKEN)!');
  console.error('Пожалуйста, создайте файл .env на основе .env.example и укажите ваш токен бота.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Обязателен для списка участников и кика
    GatewayIntentBits.GuildMessages, // Для отслеживания сообщений
    GatewayIntentBits.GuildVoiceStates, // Для отслеживания входа в голосовые каналы
  ],
});

// Запуск фонового HTTP-сервера для прохождения Health Check на Render
startHealthServer(client);

client.once(Events.ClientReady, async readyClient => {
  console.log(`🤖 Бот успешно запущен как ${readyClient.user.tag}!`);
  console.log(`📌 Правила активности: только отправка сообщений и вход в войс.`);
  console.log(`⏳ Порог неактивности: ${config.inactivityDays} дней.`);
  console.log(`⚙️ Режим кика по умолчанию: ${config.dryRun ? 'ТЕСТОВЫЙ (DRY_RUN=true)' : 'РЕАЛЬНЫЙ (DRY_RUN=false)'}`);

  readyClient.user.setActivity({
    name: `активность (${config.inactivityDays} дн.)`,
    type: ActivityType.Watching,
  });

  // Регистрируем слэш-команды
  await registerCommands(client);

  // Периодическая проверка неактивности
  const intervalMs = config.checkIntervalHours * 60 * 60 * 1000;
  console.log(`🕒 Периодическая проверка настроена: каждые ${config.checkIntervalHours} ч.`);

  // Запуск проверки через 1 минуту после старта (чтобы кэш успел прогреться), затем по интервалу
  setTimeout(async () => {
    await runScheduledCheck();
    setInterval(runScheduledCheck, intervalMs);
  }, 60 * 1000);
});

async function runScheduledCheck(): Promise<void> {
  console.log('⏰ [Scheduler] Запуск плановой проверки неактивности на всех серверах...');
  for (const [, guild] of client.guilds.cache) {
    try {
      await checkGuildInactivity(guild);
    } catch (error) {
      console.error(`[Scheduler Error] Ошибка при проверке сервера ${guild.name} (${guild.id}):`, error);
    }
  }
}

// Слушатели событий
client.on(Events.MessageCreate, handleMessageCreate);
client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    await handleInteractionCreate(interaction);
  }
});

// Обработка завершения процесса
function handleShutdown(signal: string) {
  console.log(`\n🛑 Получен сигнал ${signal}, завершение работы...`);
  activityRepo.close();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

client.login(config.discordToken).catch(err => {
  console.error('❌ Не удалось войти в Discord:', err);
  process.exit(1);
});
