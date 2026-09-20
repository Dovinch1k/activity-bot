import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ActivityRepository } from './repository.js';

const TEST_DB = './data/test_activity.db';

test('ActivityRepository records and retrieves activity', () => {
  if (fs.existsSync(TEST_DB)) {
    fs.rmSync(TEST_DB);
  }

  const repo = new ActivityRepository(TEST_DB);

  // Initial check should be null
  assert.equal(repo.getUserActivity('guild1', 'user1'), null);

  // Record message activity
  const t1 = 1700000000000;
  repo.recordActivity('guild1', 'user1', 'message', t1);
  const rec1 = repo.getUserActivity('guild1', 'user1');
  assert.notEqual(rec1, null);
  assert.equal(rec1?.user_id, 'user1');
  assert.equal(rec1?.guild_id, 'guild1');
  assert.equal(rec1?.last_active_at, t1);
  assert.equal(rec1?.last_action_type, 'message');

  // Record voice activity update (newer timestamp)
  const t2 = 1700000050000;
  repo.recordActivity('guild1', 'user1', 'voice', t2);
  const rec2 = repo.getUserActivity('guild1', 'user1');
  assert.equal(rec2?.last_active_at, t2);
  assert.equal(rec2?.last_action_type, 'voice');

  // Add another user in same guild and in another guild
  repo.recordActivity('guild1', 'user2', 'message', t1);
  repo.recordActivity('guild2', 'user3', 'voice', t1);

  const guild1Map = repo.getAllGuildActivities('guild1');
  assert.equal(guild1Map.size, 2);
  assert.equal(guild1Map.has('user1'), true);
  assert.equal(guild1Map.has('user2'), true);
  assert.equal(guild1Map.has('user3'), false);

  // Delete user
  repo.deleteUser('guild1', 'user1');
  assert.equal(repo.getUserActivity('guild1', 'user1'), null);

  repo.close();
  if (fs.existsSync(TEST_DB)) {
    fs.rmSync(TEST_DB);
  }
});
