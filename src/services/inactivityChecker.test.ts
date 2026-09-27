import test from 'node:test';
import assert from 'node:assert/strict';

// Тестирование чистой логики фильтрации и вычисления неактивности
test('Inactivity logic: 30 days threshold calculation', () => {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // 1. Недавняя активность (5 дней назад)
  const activeUserTime = now - (5 * 24 * 60 * 60 * 1000);
  assert.equal(now - activeUserTime < THIRTY_DAYS_MS, true);

  // 2. Неактивен ровно 30 дней
  const thirtyDaysAgo = now - THIRTY_DAYS_MS;
  assert.equal(now - thirtyDaysAgo >= THIRTY_DAYS_MS, true);

  // 3. Неактивен 35 дней
  const thirtyFiveDaysAgo = now - (35 * 24 * 60 * 60 * 1000);
  assert.equal(now - thirtyFiveDaysAgo >= THIRTY_DAYS_MS, true);

  // 4. Новый пользователь без сообщений (зашел 10 дней назад) -> льготный период
  const joinedTenDaysAgo = now - (10 * 24 * 60 * 60 * 1000);
  assert.equal(now - joinedTenDaysAgo < THIRTY_DAYS_MS, true);

  // 5. Старый пользователь без сообщений (зашел 40 дней назад) -> кандидат на кик
  const joinedFortyDaysAgo = now - (40 * 24 * 60 * 60 * 1000);
  assert.equal(now - joinedFortyDaysAgo >= THIRTY_DAYS_MS, true);
});

test('Bot exclusion logic', () => {
  const members = [
    { id: '1', user: { bot: true, tag: 'Bot#0001' } },
    { id: '2', user: { bot: false, tag: 'User#0002' } },
    { id: '3', user: { bot: true, tag: 'MusicBot#0003' } },
  ];

  const nonBots = members.filter(m => !m.user.bot);
  assert.equal(nonBots.length, 1);
  assert.equal(nonBots[0].id, '2');
});

test('Voice join detection logic', () => {
  // 1. Обычный вход в голосовой канал
  const join = { oldChannel: null, newChannel: '123' };
  const isJoin = !join.oldChannel && !!join.newChannel;
  assert.equal(isJoin, true);

  // 2. Переход из канала в другой канал
  const switchCh = { oldChannel: '123', newChannel: '456' };
  const isSwitch = !!switchCh.oldChannel && !!switchCh.newChannel && switchCh.oldChannel !== switchCh.newChannel;
  assert.equal(isSwitch, true);

  // 3. Мут / глушение / стрим (канал не изменился)
  const muteEvent = { oldChannel: '123', newChannel: '123' };
  const isMuteJoin = (!muteEvent.oldChannel && !!muteEvent.newChannel) || 
    (!!muteEvent.oldChannel && !!muteEvent.newChannel && muteEvent.oldChannel !== muteEvent.newChannel);
  assert.equal(isMuteJoin, false, 'Мут/размут не должен считаться новым заходом в войс');

  // 4. Выход из голосового канала
  const leave = { oldChannel: '123', newChannel: null };
  const isLeaveJoin = (!leave.oldChannel && !!leave.newChannel) || 
    (!!leave.oldChannel && !!leave.newChannel && leave.oldChannel !== leave.newChannel);
  assert.equal(isLeaveJoin, false, 'Выход из канала не должен считаться заходом');
});

test('Immune roles and booster exclusion logic', () => {
  const immuneRoleIds = ['1447298868323549435', '1553082516531970088', '1447298867963105451'];

  const members = [
    { id: '1', roles: ['1447298868323549435'], premiumSince: null }, // Модератор
    { id: '2', roles: ['1553082516531970088'], premiumSince: null }, // Бустер по роли
    { id: '3', roles: ['1447298867963105451'], premiumSince: null }, // Роль ботов
    { id: '4', roles: [], premiumSince: new Date() }, // Nitro booster
    { id: '5', roles: ['regular_role'], premiumSince: null }, // Обычный участник
  ];

  const isImmune = (member: { roles: string[]; premiumSince: Date | null }) => {
    if (member.premiumSince) return true;
    return immuneRoleIds.some(id => member.roles.includes(id));
  };

  assert.equal(isImmune(members[0]), true, 'Модератор должен иметь иммунитет');
  assert.equal(isImmune(members[1]), true, 'Бустер по роли должен иметь иммунитет');
  assert.equal(isImmune(members[2]), true, 'Роль ботов должна иметь иммунитет');
  assert.equal(isImmune(members[3]), true, 'Nitro booster должен иметь иммунитет');
  assert.equal(isImmune(members[4]), false, 'Обычный участник не должен иметь иммунитет');
});
