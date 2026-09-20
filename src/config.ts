import 'dotenv/config';

export interface Config {
  discordToken: string;
  clientId?: string;
  guildId?: string;
  inactivityDays: number;
  inactivityMs: number;
  checkIntervalHours: number;
  dryRun: boolean;
  logChannelId?: string;
  immuneRoleIds: string[];
  dbPath: string;
}

const inactivityDays = Number(process.env.INACTIVITY_DAYS) || 30;

export const config: Config = {
  discordToken: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  guildId: process.env.GUILD_ID || '',
  inactivityDays,
  inactivityMs: inactivityDays * 24 * 60 * 60 * 1000,
  checkIntervalHours: Number(process.env.CHECK_INTERVAL_HOURS) || 12,
  dryRun: process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1',
  logChannelId: process.env.LOG_CHANNEL_ID || '',
  immuneRoleIds: (process.env.IMMUNE_ROLE_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean),
  dbPath: process.env.DB_PATH || './data/activity.db',
};
