import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export interface UserActivityRecord {
  user_id: string;
  guild_id: string;
  last_active_at: number;
  last_action_type: 'message' | 'voice';
  updated_at: number;
}

export class ActivityRepository {
  private db: DatabaseSync;

  constructor(dbPath: string = config.dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    // Включаем WAL-режим для надежности
    this.db.exec('PRAGMA journal_mode = WAL;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_activity (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        last_active_at INTEGER NOT NULL,
        last_action_type TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, guild_id)
      );

      CREATE INDEX IF NOT EXISTS idx_guild_last_active 
      ON user_activity (guild_id, last_active_at);

      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        installed_at INTEGER NOT NULL,
        log_channel_id TEXT
      );
    `);

    // Безопасная миграция, если таблица была создана ранее без колонки log_channel_id
    try {
      this.db.exec('ALTER TABLE guild_settings ADD COLUMN log_channel_id TEXT;');
    } catch {
      // Колонка уже существует
    }
  }

  /**
   * Получить дату добавления бота на сервер.
   * Если бот запущен на сервере впервые, текущая дата сохраняется как точка отсчета.
   */
  public getGuildInstalledAt(guildId: string): number {
    const stmt = this.db.prepare('SELECT installed_at FROM guild_settings WHERE guild_id = ?');
    const row = stmt.get(guildId) as { installed_at: number } | undefined;
    if (row && row.installed_at) {
      return row.installed_at;
    }

    const now = Date.now();
    const insert = this.db.prepare('INSERT INTO guild_settings (guild_id, installed_at) VALUES (?, ?)');
    insert.run(guildId, now);
    return now;
  }

  /**
   * Получить настроенный ID канала логирования для гильдии
   */
  public getGuildLogChannel(guildId: string): string | null {
    const stmt = this.db.prepare('SELECT log_channel_id FROM guild_settings WHERE guild_id = ?');
    const row = stmt.get(guildId) as { log_channel_id: string | null } | undefined;
    return row?.log_channel_id || null;
  }

  /**
   * Установить или сбросить (null) канал логирования для гильдии
   */
  public setGuildLogChannel(guildId: string, channelId: string | null): void {
    const installedAt = this.getGuildInstalledAt(guildId);
    const stmt = this.db.prepare(`
      INSERT INTO guild_settings (guild_id, installed_at, log_channel_id)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        log_channel_id = excluded.log_channel_id
    `);
    stmt.run(guildId, installedAt, channelId);
  }

  /**
   * Записать активность пользователя (сообщение или вход в голосовой канал)
   */
  public recordActivity(guildId: string, userId: string, actionType: 'message' | 'voice', timestamp: number = Date.now()): void {
    const stmt = this.db.prepare(`
      INSERT INTO user_activity (user_id, guild_id, last_active_at, last_action_type, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        last_active_at = excluded.last_active_at,
        last_action_type = excluded.last_action_type,
        updated_at = excluded.updated_at
    `);

    stmt.run(userId, guildId, timestamp, actionType, timestamp);
  }

  /**
   * Записать активность, только если переданный timestamp новее уже сохраненного
   * (полезно при сканировании истории сообщений)
   */
  public recordActivityIfNewer(guildId: string, userId: string, actionType: 'message' | 'voice', timestamp: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO user_activity (user_id, guild_id, last_active_at, last_action_type, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        last_active_at = CASE WHEN excluded.last_active_at > user_activity.last_active_at THEN excluded.last_active_at ELSE user_activity.last_active_at END,
        last_action_type = CASE WHEN excluded.last_active_at > user_activity.last_active_at THEN excluded.last_action_type ELSE user_activity.last_action_type END,
        updated_at = CASE WHEN excluded.last_active_at > user_activity.last_active_at THEN excluded.updated_at ELSE user_activity.updated_at END
    `);

    stmt.run(userId, guildId, timestamp, actionType, Date.now());
  }

  /**
   * Пометить список пользователей активными прямо сейчас
   */
  public markAllActive(guildId: string, userIds: string[], timestamp: number = Date.now()): void {
    const stmt = this.db.prepare(`
      INSERT INTO user_activity (user_id, guild_id, last_active_at, last_action_type, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, guild_id) DO UPDATE SET
        last_active_at = excluded.last_active_at,
        last_action_type = excluded.last_action_type,
        updated_at = excluded.updated_at
    `);

    for (const userId of userIds) {
      stmt.run(userId, guildId, timestamp, 'message', timestamp);
    }
  }

  /**
   * Получить запись об активности конкретного пользователя
   */
  public getUserActivity(guildId: string, userId: string): UserActivityRecord | null {
    const stmt = this.db.prepare(`
      SELECT user_id, guild_id, last_active_at, last_action_type, updated_at
      FROM user_activity
      WHERE guild_id = ? AND user_id = ?
    `);

    const row = stmt.get(guildId, userId) as UserActivityRecord | undefined;
    return row || null;
  }

  /**
   * Получить активность всех сохраненных пользователей гильдии
   */
  public getAllGuildActivities(guildId: string): Map<string, UserActivityRecord> {
    const stmt = this.db.prepare(`
      SELECT user_id, guild_id, last_active_at, last_action_type, updated_at
      FROM user_activity
      WHERE guild_id = ?
    `);

    const rows = stmt.all(guildId) as unknown as UserActivityRecord[];
    const map = new Map<string, UserActivityRecord>();
    for (const row of rows) {
      map.set(row.user_id, row);
    }
    return map;
  }

  /**
   * Удалить запись (например, после кика)
   */
  public deleteUser(guildId: string, userId: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM user_activity
      WHERE guild_id = ? AND user_id = ?
    `);
    stmt.run(guildId, userId);
  }

  public close(): void {
    this.db.close();
  }
}

export const activityRepo = new ActivityRepository();
