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
    `);
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
