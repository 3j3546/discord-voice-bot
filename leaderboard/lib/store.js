// Upstash Redis 저장소 + XP/설정 로직
const { Redis } = require('@upstash/redis');
const { periodKeys, levelInfo, rand } = require('./util');

// 디스코드 ID는 큰 숫자라 자동 JSON 변환을 끄고 문자열로만 다룬다
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  automaticDeserialization: false,
});

const key = {
  cfg: (g) => `lb:${g}:cfg`,
  user: (g, u) => `lb:${g}:u:${u}`,
  board: (g, type, period) => `lb:${g}:b:${type}:${period}`,
  inv: (g, u) => `lb:${g}:inv:${u}`, // 인벤토리 (상품번호 -> 개수)
  stock: (g) => `lb:${g}:stock`, // 한정 수량 상품 남은 재고 (상품번호 -> 개수)
  exp: (g) => `lb:${g}:exp`, // 기간제 역할 만료 (member = 유저ID:역할ID, score = 만료시각 ms)
};

const DEFAULT_CONFIG = {
  xpMin: 15,
  xpMax: 25,
  cooldown: 60, // 초
  multiplier: 1,
  voiceXp: 10, // 음성 1분당
  voiceRequireOthers: true, // 혼자 있으면 XP 없음
  levelUpEnabled: true,
  levelUpChannel: null, // null = 메시지 쓴 채널
  levelUpMessage: '{user}님이 **{level}레벨**이 되었어요! 🎉',
  ignoredChannels: [],
  ignoredRoles: [],
  stackRoles: true, // true = 레벨 역할 누적, false = 가장 높은 것만
  rewards: [], // { level, roleId }
  attendPoints: 100,
  attendBonusPerStreak: 5, // 연속 출석 1일당 추가 포인트 (최대 30일)
  attendXp: 50,
  shop: [], // { id, type: 'role'|'item'|'xp', name, price, desc, roleId, days, xp, limited }
  shopSeq: 0, // 다음 상품 번호 계산용
  shopLogChannel: null, // 구매/사용 알림을 받을 채널
  prefix: '!', // 접두사 명령어 (예: !상점)
  prefixEnabled: true,
  levelUpPoints: 0, // 레벨업 1회당 지급 포인트
  channelMult: {}, // 채널ID -> XP 배율
  roleMult: {}, // 역할ID -> XP 배율 (부스터용, 가장 높은 값 적용)
};

const cfgCache = new Map(); // guildId -> { at, cfg }
const CFG_TTL = 30_000;

async function getConfig(guildId) {
  const hit = cfgCache.get(guildId);
  if (hit && Date.now() - hit.at < CFG_TTL) return hit.cfg;
  let saved = {};
  try {
    const raw = await redis.get(key.cfg(guildId));
    if (raw) saved = JSON.parse(raw);
  } catch (e) {
    console.error('설정 읽기 실패:', e.message);
  }
  const cfg = { ...DEFAULT_CONFIG, ...saved };
  cfgCache.set(guildId, { at: Date.now(), cfg });
  return cfg;
}

async function saveConfig(guildId, cfg) {
  await redis.set(key.cfg(guildId), JSON.stringify(cfg));
  cfgCache.set(guildId, { at: Date.now(), cfg });
}

async function updateConfig(guildId, fn) {
  const cfg = { ...(await getConfig(guildId)) };
  fn(cfg);
  await saveConfig(guildId, cfg);
  return cfg;
}

// type: 'chat' | 'voice' | 'admin'(관리자·출석 등, 종합에만 반영)
async function addXp(guildId, userId, amount, type = 'chat', extra = {}) {
  const periods = periodKeys();
  const p = redis.pipeline();
  const boards = ['total'];
  if (type === 'chat' || type === 'voice') boards.push(type);

  p.zincrby(key.board(guildId, 'total', 'all'), amount, userId); // 결과 [0]
  for (const b of boards) {
    if (b !== 'total') p.zincrby(key.board(guildId, b, 'all'), amount, userId);
    for (const [pk, ttl] of [
      [`d:${periods.d}`, 60 * 86400],
      [`w:${periods.w}`, 200 * 86400],
      [`m:${periods.m}`, 800 * 86400],
    ]) {
      const k = key.board(guildId, b, pk);
      p.zincrby(k, amount, userId);
      p.expire(k, ttl);
    }
  }
  const field = { chat: 'chatXp', voice: 'voiceXp', admin: 'adminXp' }[type];
  p.hincrby(key.user(guildId, userId), field, amount);
  for (const [f, v] of Object.entries(extra)) p.hincrby(key.user(guildId, userId), f, v);

  const res = await p.exec();
  let newTotal = Number(res[0]);
  if (newTotal < 0) {
    await redis.zadd(key.board(guildId, 'total', 'all'), { score: 0, member: userId });
    newTotal = 0;
  }
  const oldTotal = newTotal - amount;
  return {
    newTotal,
    oldTotal: Math.max(0, oldTotal),
    oldLevel: levelInfo(Math.max(0, oldTotal)).level,
    newLevel: levelInfo(newTotal).level,
  };
}

async function setTotalXp(guildId, userId, xp) {
  xp = Math.max(0, Math.floor(xp));
  await redis.zadd(key.board(guildId, 'total', 'all'), { score: xp, member: userId });
  return levelInfo(xp).level;
}

async function resetUser(guildId, userId) {
  const p = redis.pipeline();
  for (const t of ['total', 'chat', 'voice']) p.zrem(key.board(guildId, t, 'all'), userId);
  p.hdel(key.user(guildId, userId), 'chatXp', 'voiceXp', 'adminXp', 'msgs', 'voiceMin');
  await p.exec();
}

async function getStats(guildId, userId) {
  const raw = (await redis.hgetall(key.user(guildId, userId))) || {};
  const n = (k) => Number(raw[k] || 0);
  return {
    chatXp: n('chatXp'),
    voiceXp: n('voiceXp'),
    msgs: n('msgs'),
    voiceMin: n('voiceMin'),
    points: n('points'),
    streak: n('streak'),
    bestStreak: n('bestStreak'),
    lastAttend: raw.lastAttend || null,
  };
}

async function getScore(guildId, type, period, userId) {
  const s = await redis.zscore(key.board(guildId, type, period), userId);
  return s === null || s === undefined ? 0 : Number(s);
}

async function getRankPos(guildId, type, period, userId) {
  const r = await redis.zrank(key.board(guildId, type, period), userId, { rev: true });
  return r === null || r === undefined ? null : Number(r) + 1;
}

async function getTop(guildId, type, period, start, stop) {
  const flat = await redis.zrange(key.board(guildId, type, period), start, stop, {
    rev: true,
    withScores: true,
  });
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ userId: String(flat[i]), score: Number(flat[i + 1]) });
  return out;
}

async function boardSize(guildId, type, period) {
  return Number(await redis.zcard(key.board(guildId, type, period))) || 0;
}

// 레벨에 맞게 보상 역할 지급/회수
async function syncRoles(member, level, cfg) {
  if (!cfg.rewards.length) return;
  const earned = cfg.rewards.filter((r) => r.level <= level).sort((a, b) => a.level - b.level);
  let shouldHave = earned.map((r) => r.roleId);
  if (!cfg.stackRoles && earned.length) shouldHave = [earned[earned.length - 1].roleId];
  const all = cfg.rewards.map((r) => r.roleId);
  try {
    const toAdd = shouldHave.filter((id) => !member.roles.cache.has(id) && member.guild.roles.cache.has(id));
    const toRemove = all.filter((id) => !shouldHave.includes(id) && member.roles.cache.has(id));
    if (toAdd.length) await member.roles.add(toAdd, '레벨 보상');
    if (toRemove.length) await member.roles.remove(toRemove, '레벨 보상 조정');
  } catch (e) {
    console.error('역할 지급 실패(봇 역할 위치/권한 확인):', e.message);
  }
}

function formatLevelUp(template, member, level) {
  return template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.displayName ?? member.user?.username ?? '')
    .replaceAll('{level}', String(level))
    .replaceAll('{server}', member.guild.name);
}

async function handleLevelUp(member, result, cfg, fallbackChannel) {
  if (result.newLevel === result.oldLevel) return;
  await syncRoles(member, result.newLevel, cfg);
  if (result.newLevel > result.oldLevel && cfg.levelUpPoints > 0) {
    await redis.hincrby(key.user(member.guild.id, member.id), 'points', cfg.levelUpPoints * (result.newLevel - result.oldLevel));
  }
  if (result.newLevel < result.oldLevel || !cfg.levelUpEnabled) return;
  const channel =
    (cfg.levelUpChannel && member.guild.channels.cache.get(cfg.levelUpChannel)) ||
    fallbackChannel ||
    member.guild.systemChannel;
  if (!channel || !channel.isTextBased()) return;
  try {
    await channel.send({
      content: formatLevelUp(cfg.levelUpMessage, member, result.newLevel),
      allowedMentions: { users: [member.id] },
    });
  } catch (e) {
    /* 권한 없으면 무시 */
  }
}

// 서버 배율 × 채널 배율 × (가진 역할 중 가장 높은 부스터 배율), 최대 20배
function multiplierFor(cfg, member, channelId, parentId) {
  const cm = cfg.channelMult || {};
  let m = cfg.multiplier * (cm[channelId] ?? (parentId ? cm[parentId] : undefined) ?? 1);
  let best = 1;
  for (const [roleId, x] of Object.entries(cfg.roleMult || {})) {
    if (x > best && member.roles.cache.has(roleId)) best = x;
  }
  return Math.min(20, m * best);
}

function randomXp(cfg, mult = cfg.multiplier) {
  return Math.max(1, Math.round(rand(cfg.xpMin, Math.max(cfg.xpMin, cfg.xpMax)) * mult));
}

// 기간제 역할 만료 처리 (1분마다 호출)
async function expireRoles(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const due = await redis.zrange(key.exp(guild.id), 0, Date.now(), { byScore: true });
      for (const entry of due) {
        const [userId, roleId] = String(entry).split(':');
        try {
          const member = await guild.members.fetch(userId);
          await member.roles.remove(roleId, '기간제 역할 만료');
        } catch (e) {
          /* 나간 유저, 삭제된 역할, 권한 부족이면 그냥 기록만 정리 */
        }
        await redis.zrem(key.exp(guild.id), entry);
      }
    } catch (e) {
      console.error('기간제 역할 정리 오류:', e.message);
    }
  }
}

module.exports = {
  redis,
  key,
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  updateConfig,
  addXp,
  setTotalXp,
  resetUser,
  getStats,
  getScore,
  getRankPos,
  getTop,
  boardSize,
  syncRoles,
  handleLevelUp,
  randomXp,
  multiplierFor,
  expireRoles,
};
