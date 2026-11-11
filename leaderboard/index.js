// 레벨링 · 랭킹 · 출석 · 포인트 상점 모듈 (입퇴장알리미 index.js에서 불러 써요)
// 저장소는 기존 봇과 같은 Upstash Redis를 쓰고, 키 이름이 모두 `lb:`로 시작해서 서로 섞이지 않아요.
const S = require('./lib/store');
const { data, handlers } = require('./commands');
const { handlePrefix } = require('./prefix');

const cooldowns = new Map(); // `${guildId}:${userId}` -> 마지막 XP 시각

function isIgnored(cfg, member, channelId, parentId) {
  if (cfg.ignoredChannels.includes(channelId) || (parentId && cfg.ignoredChannels.includes(parentId))) return true;
  return cfg.ignoredRoles.some((id) => member.roles.cache.has(id));
}

// 채팅 XP. 접두사 명령어(예: !상점)로 처리된 메시지면 true를 돌려줘요(→ 호출한 쪽은 그 메시지를 더 처리하지 않아요).
async function onMessage(message) {
  try {
    if (!message.guild || message.author.bot || message.webhookId || !message.member) return false;
    const cfg = await S.getConfig(message.guildId);

    if (cfg.prefixEnabled && cfg.prefix && message.content.startsWith(cfg.prefix)) {
      const handled = await handlePrefix(message, cfg, data, handlers);
      if (handled) return true;
    }

    const ck = `${message.guildId}:${message.author.id}`;
    const now = Date.now();
    if (now - (cooldowns.get(ck) ?? 0) < cfg.cooldown * 1000) return false;
    if (isIgnored(cfg, message.member, message.channelId, message.channel.parentId)) return false;
    cooldowns.set(ck, now);

    // 다른 기능(끝말잇기, 챗봇)이 느려지지 않게 XP 저장은 기다리지 않고 뒤에서 처리해요.
    const mult = S.multiplierFor(cfg, message.member, message.channelId, message.channel.parentId);
    S.addXp(message.guildId, message.author.id, S.randomXp(cfg, mult), 'chat', { msgs: 1 })
      .then((result) => S.handleLevelUp(message.member, result, cfg, message.channel))
      .catch((e) => console.error('채팅 XP 오류:', e.message));
  } catch (e) {
    console.error('레벨링 메시지 처리 오류:', e.message);
  }
  return false;
}

// 슬래시 명령어 실행 (처리했으면 true)
async function runSlash(i) {
  const run = handlers[i.commandName];
  if (!run) return false;
  if (!i.inGuild()) {
    await i.reply({ content: '서버에서만 쓸 수 있어요.', flags: 64 }).catch(() => {});
    return true;
  }
  try {
    await run(i);
  } catch (e) {
    console.error(`/${i.commandName} 오류:`, e);
    const msg = { content: '⚠️ 처리 중 오류가 났어요. 잠시 뒤 다시 시도해 주세요.', flags: 64 };
    if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
  return true;
}

// 음성 XP (1분마다)
async function voiceTick(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const cfg = await S.getConfig(guild.id);
      if (cfg.voiceXp <= 0) continue;
      const byChannel = new Map();
      for (const vs of guild.voiceStates.cache.values()) {
        if (!vs.channelId || !vs.member || vs.member.user.bot) continue;
        if (!byChannel.has(vs.channelId)) byChannel.set(vs.channelId, []);
        byChannel.get(vs.channelId).push(vs);
      }
      for (const [channelId, states] of byChannel) {
        if (channelId === guild.afkChannelId) continue;
        if (cfg.voiceRequireOthers && states.length < 2) continue;
        for (const vs of states) {
          if (vs.deaf || vs.selfDeaf) continue; // 헤드셋 끈 사람은 제외
          if (isIgnored(cfg, vs.member, channelId, vs.channel?.parentId)) continue;
          const amount = Math.max(1, Math.round(cfg.voiceXp * S.multiplierFor(cfg, vs.member, channelId, vs.channel?.parentId)));
          const result = await S.addXp(guild.id, vs.id, amount, 'voice', { voiceMin: 1 });
          await S.handleLevelUp(vs.member, result, cfg, null);
        }
      }
    } catch (e) {
      console.error('음성 XP 오류:', e.message);
    }
  }
}

// 봇이 준비되면 한 번 호출: 음성 XP와 기간제 역할 만료 확인을 시작해요.
function start(client) {
  setInterval(() => voiceTick(client).catch((e) => console.error(e.message)), 60_000);
  setInterval(() => S.expireRoles(client), 60_000);
  S.expireRoles(client);
  console.log(`🏆 레벨링 모듈 시작 (명령어 ${data.length}개)`);
}

module.exports = { data, handlers, onMessage, runSlash, start };
