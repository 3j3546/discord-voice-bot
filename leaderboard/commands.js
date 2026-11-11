// 슬래시 명령어 정의 + 처리
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const S = require('./lib/store');
const { periodKeys, today, yesterday, levelInfo, num, bar, fmtMinutes } = require('./lib/util');

const COLOR = 0x5865f2;
const ADMIN = PermissionFlagsBits.ManageGuild;
const PAGE_SIZE = 10;

const TYPE_LABEL = { total: '종합', chat: '채팅', voice: '음성' };
const PERIOD_LABEL = { all: '전체', d: '오늘', w: '이번 주', m: '이번 달' };

function periodKey(p) {
  if (p === 'all') return 'all';
  return `${p}:${periodKeys()[p]}`;
}

const data = [];
const handlers = {};

function add(builder, handler) {
  data.push(builder);
  handlers[builder.name] = handler;
}

const err = (i, msg) => i.reply({ content: `⚠️ ${msg}`, flags: MessageFlags.Ephemeral });

// ───────────────────────── /랭크 ─────────────────────────
add(
  new SlashCommandBuilder()
    .setName('랭크')
    .setDescription('내(또는 다른 사람의) 레벨과 순위를 확인해요')
    .addUserOption((o) => o.setName('유저').setDescription('확인할 유저')),
  async (i) => {
    const user = i.options.getUser('유저') ?? i.user;
    if (user.bot) return err(i, '봇은 랭킹에 없어요.');
    await i.deferReply();
    const g = i.guildId;
    const [stats, total, pos, dayXp, weekXp, total_n, chatPos, voicePos, nextRoles] = await Promise.all([
      S.getStats(g, user.id),
      S.getScore(g, 'total', 'all', user.id),
      S.getRankPos(g, 'total', 'all', user.id),
      S.getScore(g, 'total', periodKey('d'), user.id),
      S.getScore(g, 'total', periodKey('w'), user.id),
      S.boardSize(g, 'total', 'all'),
      S.getRankPos(g, 'chat', 'all', user.id),
      S.getRankPos(g, 'voice', 'all', user.id),
      S.getConfig(g),
    ]);
    const cfgNow = nextRoles;
    const nextReward = [...cfgNow.rewards].sort((a, b) => a.level - b.level).find((r) => r.level > levelInfo(total).level);
    const lv = levelInfo(total);
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setAuthor({ name: `${user.displayName ?? user.username}님의 랭크`, iconURL: user.displayAvatarURL() })
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .setDescription(
        `**Lv. ${lv.level}**  ·  ${pos ? `#${num(pos)} / ${num(total_n)}위` : '순위 없음'}\n` +
          `${bar(lv.current, lv.needed, 14)}\n` +
          `\`${num(lv.current)} / ${num(lv.needed)} XP\`  (총 ${num(total)} XP)`,
      )
      .addFields(
        { name: '💬 채팅', value: `${num(stats.chatXp)} XP${chatPos ? ` (#${num(chatPos)})` : ''}\n메시지 ${num(stats.msgs)}개`, inline: true },
        { name: '🎙️ 음성', value: `${num(stats.voiceXp)} XP${voicePos ? ` (#${num(voicePos)})` : ''}\n${fmtMinutes(stats.voiceMin)}`, inline: true },
        { name: '📅 기간별', value: `오늘 ${num(dayXp)} XP\n이번 주 ${num(weekXp)} XP`, inline: true },
        { name: '💰 포인트', value: `${num(stats.points)} P`, inline: true },
        { name: '🔥 연속 출석', value: `${num(stats.streak)}일 (최고 ${num(stats.bestStreak)}일)`, inline: true },
        {
          name: '🎖️ 다음 보상',
          value: nextReward ? `Lv.${nextReward.level} → <@&${nextReward.roleId}>` : '없음',
          inline: true,
        },
      );
    await i.editReply({ embeds: [embed] });
  },
);

// ───────────────────────── /리더보드 ─────────────────────────
add(
  new SlashCommandBuilder()
    .setName('리더보드')
    .setDescription('서버 랭킹 TOP을 보여줘요')
    .addStringOption((o) =>
      o
        .setName('종류')
        .setDescription('어떤 XP 순위?')
        .addChoices(
          { name: '종합', value: 'total' },
          { name: '채팅', value: 'chat' },
          { name: '음성', value: 'voice' },
        ),
    )
    .addStringOption((o) =>
      o
        .setName('기간')
        .setDescription('기간 (한국 시간 기준)')
        .addChoices(
          { name: '전체', value: 'all' },
          { name: '오늘', value: 'd' },
          { name: '이번 주(월~일)', value: 'w' },
          { name: '이번 달', value: 'm' },
        ),
    ),
  async (i) => {
    await i.deferReply();
    const type = i.options.getString('종류') ?? 'total';
    const per = i.options.getString('기간') ?? 'all';
    const g = i.guildId;
    const pk = periodKey(per);
    const size = await S.boardSize(g, type, pk);
    const pages = Math.max(1, Math.ceil(size / PAGE_SIZE));
    const myPos = await S.getRankPos(g, type, pk, i.user.id);
    let page = 0;

    const render = async () => {
      const rows = await S.getTop(g, type, pk, page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const medals = ['🥇', '🥈', '🥉'];
      const lines = rows.map((r, idx) => {
        const rank = page * PAGE_SIZE + idx + 1;
        const mark = rank <= 3 ? medals[rank - 1] : `**${rank}.**`;
        const lvText = type === 'total' && per === 'all' ? `Lv.${levelInfo(r.score).level} · ` : '';
        return `${mark} <@${r.userId}> — ${lvText}${num(r.score)} XP`;
      });
      return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`🏆 ${i.guild.name} ${PERIOD_LABEL[per]} ${TYPE_LABEL[type]} 랭킹`)
        .setDescription(lines.length ? lines.join('\n') : '아직 기록이 없어요.')
        .setFooter({ text: `${page + 1} / ${pages} 페이지${myPos ? ` · 내 순위 ${num(myPos)}위` : ''}` });
    };
    const buttons = () =>
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
        new ButtonBuilder()
          .setCustomId('next')
          .setLabel('▶')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= pages - 1),
      );

    const msg = await i.editReply({ embeds: [await render()], components: pages > 1 ? [buttons()] : [] });
    if (pages <= 1) return;
    const collector = msg.createMessageComponentCollector({ time: 120_000 });
    collector.on('collect', async (b) => {
      if (b.user.id !== i.user.id) return b.reply({ content: '명령어를 쓴 사람만 넘길 수 있어요.', flags: MessageFlags.Ephemeral });
      page += b.customId === 'next' ? 1 : -1;
      await b.update({ embeds: [await render()], components: [buttons()] });
    });
    collector.on('end', () => i.editReply({ components: [] }).catch(() => {}));
  },
);

// ───────────────────────── /출석 ─────────────────────────
add(new SlashCommandBuilder().setName('출석').setDescription('하루에 한 번 출석하고 포인트와 XP를 받아요'), async (i) => {
  await i.deferReply();
  const g = i.guildId;
  const cfg = await S.getConfig(g);
  const stats = await S.getStats(g, i.user.id);
  const td = today();
  if (stats.lastAttend === td) {
    return i.editReply(`이미 오늘 출석했어요! 🔥 연속 ${stats.streak}일 · 내일 또 만나요.`);
  }
  const streak = stats.lastAttend === yesterday() ? stats.streak + 1 : 1;
  const points = cfg.attendPoints + Math.min(streak, 30) * cfg.attendBonusPerStreak;
  const hk = S.key.user(g, i.user.id);
  await S.redis.hset(hk, { lastAttend: td, streak: String(streak), bestStreak: String(Math.max(streak, stats.bestStreak)) });
  const newPoints = await S.redis.hincrby(hk, 'points', points);
  let xpText = '';
  if (cfg.attendXp > 0) {
    const r = await S.addXp(g, i.user.id, cfg.attendXp, 'admin');
    await S.handleLevelUp(i.member, r, cfg, i.channel);
    xpText = ` · +${num(cfg.attendXp)} XP`;
  }
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ 출석 완료!')
    .setDescription(`+${num(points)} P${xpText}\n🔥 연속 출석 **${streak}일**\n💰 보유 포인트 **${num(newPoints)} P**`);
  await i.editReply({ embeds: [embed] });
});

// ───────────────────────── /포인트 ─────────────────────────
add(
  new SlashCommandBuilder()
    .setName('포인트')
    .setDescription('보유 포인트를 확인해요')
    .addUserOption((o) => o.setName('유저').setDescription('확인할 유저')),
  async (i) => {
    const user = i.options.getUser('유저') ?? i.user;
    const stats = await S.getStats(i.guildId, user.id);
    await i.reply(`💰 ${user.displayName ?? user.username}님의 포인트: **${num(stats.points)} P**`);
  },
);

// ───────────────────────── /선물 ─────────────────────────
add(
  new SlashCommandBuilder()
    .setName('선물')
    .setDescription('다른 사람에게 포인트를 보내요')
    .addUserOption((o) => o.setName('유저').setDescription('받을 사람').setRequired(true))
    .addIntegerOption((o) => o.setName('금액').setDescription('보낼 포인트').setRequired(true).setMinValue(1)),
  async (i) => {
    const to = i.options.getUser('유저');
    const amount = i.options.getInteger('금액');
    if (to.bot || to.id === i.user.id) return err(i, '그 사람에게는 보낼 수 없어요.');
    const fromKey = S.key.user(i.guildId, i.user.id);
    const left = await S.redis.hincrby(fromKey, 'points', -amount);
    if (left < 0) {
      await S.redis.hincrby(fromKey, 'points', amount);
      return err(i, '포인트가 부족해요.');
    }
    await S.redis.hincrby(S.key.user(i.guildId, to.id), 'points', amount);
    await i.reply(`🎁 <@${i.user.id}>님이 <@${to.id}>님에게 **${num(amount)} P**를 선물했어요!`);
  },
);

// ───────────────────────── /상점 · /상점관리 · /인벤토리 · /사용 (shop.js) ─────────────────────────
require('./shop')(add, { err, COLOR, ADMIN });

// ───────────────────────── /레벨역할 ─────────────────────────
add(
  new SlashCommandBuilder()
    .setName('레벨역할')
    .setDescription('레벨 달성 시 주는 역할을 관리해요 (관리자)')
    .setDefaultMemberPermissions(ADMIN)
    .setContexts(0)
    .addSubcommand((s) =>
      s
        .setName('추가')
        .setDescription('레벨 보상 역할 추가')
        .addIntegerOption((o) => o.setName('레벨').setDescription('필요 레벨').setRequired(true).setMinValue(1).setMaxValue(500))
        .addRoleOption((o) => o.setName('역할').setDescription('지급할 역할').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('삭제')
        .setDescription('레벨 보상 삭제')
        .addIntegerOption((o) => o.setName('레벨').setDescription('삭제할 레벨').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('목록').setDescription('레벨 보상 목록'))
    .addSubcommand((s) =>
      s
        .setName('누적')
        .setDescription('역할을 누적해서 줄지(켜짐) 가장 높은 것만 줄지(꺼짐)')
        .addBooleanOption((o) => o.setName('켜기').setDescription('true=누적, false=최고 레벨만').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('동기화').setDescription('내 레벨에 맞는 역할을 지금 다시 받아요')),
  async (i) => {
    const sub = i.options.getSubcommand();
    const g = i.guildId;
    if (sub === '추가') {
      const level = i.options.getInteger('레벨');
      const role = i.options.getRole('역할');
      await S.updateConfig(g, (c) => {
        c.rewards = [...c.rewards.filter((r) => r.level !== level), { level, roleId: role.id }].sort((a, b) => a.level - b.level);
      });
      return i.reply({ content: `✅ ${level}레벨 달성 시 <@&${role.id}> 지급`, allowedMentions: { parse: [] } });
    }
    if (sub === '삭제') {
      const level = i.options.getInteger('레벨');
      await S.updateConfig(g, (c) => {
        c.rewards = c.rewards.filter((r) => r.level !== level);
      });
      return i.reply(`🗑️ ${level}레벨 보상을 삭제했어요.`);
    }
    if (sub === '누적') {
      const on = i.options.getBoolean('켜기');
      await S.updateConfig(g, (c) => {
        c.stackRoles = on;
      });
      return i.reply(on ? '✅ 레벨 역할을 누적해서 지급해요.' : '✅ 가장 높은 레벨 역할만 유지해요.');
    }
    if (sub === '동기화') {
      const cfg = await S.getConfig(g);
      const total = await S.getScore(g, 'total', 'all', i.user.id);
      await S.syncRoles(i.member, levelInfo(total).level, cfg);
      return i.reply({ content: '🔄 역할을 다시 맞췄어요.', flags: MessageFlags.Ephemeral });
    }
    const cfg = await S.getConfig(g);
    const lines = cfg.rewards.map((r) => `**Lv.${r.level}** → <@&${r.roleId}>`);
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('🎖️ 레벨 보상 역할')
          .setDescription(lines.length ? lines.join('\n') : '설정된 보상이 없어요.')
          .setFooter({ text: cfg.stackRoles ? '역할 누적 지급' : '가장 높은 역할만 유지' }),
      ],
      allowedMentions: { parse: [] },
    });
  },
);

// 확인 버튼을 거쳐 서버 전체 XP 기록 삭제 (포인트·인벤토리는 유지)
async function scanDelete(pattern) {
  let cursor = '0';
  do {
    const [next, keys] = await S.redis.scan(cursor, { match: pattern, count: 200 });
    cursor = String(next);
    if (keys.length) await S.redis.del(...keys);
  } while (cursor !== '0');
}

async function resetAllXp(i) {
  const g = i.guildId;
  const row = (disabled) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('yes').setLabel('전부 삭제').setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId('no').setLabel('취소').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    );
  const msg = await i.reply({
    content: '⚠️ **서버 전체 XP·레벨·랭킹 기록이 모두 지워져요.** (포인트와 인벤토리는 그대로) 정말 진행할까요?',
    components: [row(false)],
    fetchReply: true,
  });
  const res = await msg.awaitMessageComponent({ filter: (b) => b.user.id === i.user.id, time: 30_000 }).catch(() => null);
  if (!res || res.customId === 'no') {
    const text = res ? '취소했어요.' : '시간이 지나 취소됐어요.';
    if (res) return res.update({ content: text, components: [] });
    return i.editReply({ content: text, components: [] }).catch(() => {});
  }
  await res.update({ content: '🧹 지우는 중...', components: [] });
  await scanDelete(`lb:${g}:b:*`);
  // 유저별 XP 관련 필드만 제거
  let cursor = '0';
  do {
    const [next, keys] = await S.redis.scan(cursor, { match: `lb:${g}:u:*`, count: 200 });
    cursor = String(next);
    for (const k of keys) await S.redis.hdel(k, 'chatXp', 'voiceXp', 'adminXp', 'msgs', 'voiceMin');
  } while (cursor !== '0');
  await res.editReply('✅ 서버 전체 XP 기록을 초기화했어요. (이미 받은 레벨 역할은 `/레벨역할 동기화`로 각자 다시 맞춰요)');
}

// ───────────────────────── /xp ─────────────────────────
add(
  new SlashCommandBuilder()
    .setName('xp')
    .setDescription('유저 XP를 직접 조정해요 (관리자)')
    .setDefaultMemberPermissions(ADMIN)
    .setContexts(0)
    .addSubcommand((s) =>
      s
        .setName('지급')
        .setDescription('XP 지급')
        .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
        .addIntegerOption((o) => o.setName('양').setDescription('XP').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('차감')
        .setDescription('XP 차감')
        .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
        .addIntegerOption((o) => o.setName('양').setDescription('XP').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('설정')
        .setDescription('총 XP를 특정 값으로')
        .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
        .addIntegerOption((o) => o.setName('양').setDescription('XP').setRequired(true).setMinValue(0)),
    )
    .addSubcommand((s) =>
      s
        .setName('초기화')
        .setDescription('유저의 XP 기록 삭제')
        .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('포인트')
        .setDescription('포인트 지급/차감 (음수 가능)')
        .addUserOption((o) => o.setName('유저').setDescription('대상').setRequired(true))
        .addIntegerOption((o) => o.setName('양').setDescription('포인트 (음수=차감)').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('전체초기화').setDescription('서버 전체 XP 기록을 모두 지워요 (포인트는 유지)')),
  async (i) => {
    const sub = i.options.getSubcommand();
    if (sub === '전체초기화') return resetAllXp(i);
    const user = i.options.getUser('유저');
    if (user.bot) return err(i, '봇은 대상이 될 수 없어요.');
    const g = i.guildId;
    const cfg = await S.getConfig(g);
    const member = await i.guild.members.fetch(user.id).catch(() => null);

    if (sub === '초기화') {
      await S.resetUser(g, user.id);
      if (member) await S.syncRoles(member, 0, cfg);
      return i.reply(`🧹 <@${user.id}>님의 XP 기록을 초기화했어요.`);
    }
    if (sub === '포인트') {
      const amount = i.options.getInteger('양');
      const now = await S.redis.hincrby(S.key.user(g, user.id), 'points', amount);
      if (now < 0) await S.redis.hset(S.key.user(g, user.id), { points: '0' });
      return i.reply(`💰 <@${user.id}>님의 포인트: **${num(Math.max(0, now))} P**`);
    }
    const amount = i.options.getInteger('양');
    let result;
    if (sub === '설정') {
      const before = await S.getScore(g, 'total', 'all', user.id);
      const newLevel = await S.setTotalXp(g, user.id, amount);
      result = { oldLevel: levelInfo(before).level, newLevel };
    } else {
      result = await S.addXp(g, user.id, sub === '지급' ? amount : -amount, 'admin');
    }
    if (member) {
      await S.syncRoles(member, result.newLevel, cfg);
      // 관리자 조정으로 인한 레벨업은 알림 없이 조용히 반영
    }
    const total = await S.getScore(g, 'total', 'all', user.id);
    await i.reply(`✅ <@${user.id}>님: **${num(total)} XP** (Lv.${levelInfo(total).level})`);
  },
);

// ───────────────────────── /설정 ─────────────────────────
add(
  new SlashCommandBuilder()
    .setName('설정')
    .setDescription('레벨링 봇 설정 (관리자)')
    .setDefaultMemberPermissions(ADMIN)
    .setContexts(0)
    .addSubcommand((s) => s.setName('보기').setDescription('현재 설정 보기'))
    .addSubcommand((s) =>
      s
        .setName('xp범위')
        .setDescription('메시지 1개당 얻는 XP 범위')
        .addIntegerOption((o) => o.setName('최소').setDescription('최소 XP').setRequired(true).setMinValue(1).setMaxValue(1000))
        .addIntegerOption((o) => o.setName('최대').setDescription('최대 XP').setRequired(true).setMinValue(1).setMaxValue(1000)),
    )
    .addSubcommand((s) =>
      s
        .setName('쿨다운')
        .setDescription('XP를 다시 받기까지 걸리는 시간(초)')
        .addIntegerOption((o) => o.setName('초').setDescription('초').setRequired(true).setMinValue(0).setMaxValue(3600)),
    )
    .addSubcommand((s) =>
      s
        .setName('배율')
        .setDescription('전체 XP 배율 (이벤트용, 예: 2 = 2배)')
        .addNumberOption((o) => o.setName('배').setDescription('0.1 ~ 10').setRequired(true).setMinValue(0.1).setMaxValue(10)),
    )
    .addSubcommand((s) =>
      s
        .setName('음성')
        .setDescription('음성채널 XP 설정')
        .addIntegerOption((o) => o.setName('분당xp').setDescription('1분마다 얻는 XP (0=끄기)').setRequired(true).setMinValue(0).setMaxValue(500))
        .addBooleanOption((o) => o.setName('혼자있으면제외').setDescription('혼자 있으면 XP 없음 (기본 켜짐)')),
    )
    .addSubcommand((s) =>
      s
        .setName('레벨업알림')
        .setDescription('레벨업 알림 설정')
        .addBooleanOption((o) => o.setName('켜기').setDescription('알림 켜기/끄기').setRequired(true))
        .addChannelOption((o) =>
          o.setName('채널').setDescription('알림 채널 (생략하면 메시지 쓴 채널)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('레벨업메시지')
        .setDescription('레벨업 알림 문구. {user} {username} {level} {server} 사용 가능')
        .addStringOption((o) => o.setName('문구').setDescription('예: {user}님 {level}레벨 달성!').setRequired(true).setMaxLength(300)),
    )
    .addSubcommand((s) =>
      s
        .setName('무시채널')
        .setDescription('이 채널은 XP 제외 (다시 하면 해제)')
        .addChannelOption((o) => o.setName('채널').setDescription('텍스트/음성 채널').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('무시역할')
        .setDescription('이 역할은 XP 제외 (다시 하면 해제)')
        .addRoleOption((o) => o.setName('역할').setDescription('대상 역할').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('출석')
        .setDescription('출석 보상 설정')
        .addIntegerOption((o) => o.setName('포인트').setDescription('기본 포인트').setRequired(true).setMinValue(0))
        .addIntegerOption((o) => o.setName('연속보너스').setDescription('연속 1일당 추가 포인트 (최대 30일)').setMinValue(0))
        .addIntegerOption((o) => o.setName('xp').setDescription('출석 시 XP').setMinValue(0)),
    )
    .addSubcommand((s) =>
      s
        .setName('접두사')
        .setDescription('! 같은 글자 명령어 설정 (예: !상점)')
        .addStringOption((o) => o.setName('글자').setDescription('접두사 (예: ! ? .)').setRequired(true).setMaxLength(5))
        .addBooleanOption((o) => o.setName('켜기').setDescription('접두사 명령어 켜기/끄기')),
    )
    .addSubcommand((s) =>
      s
        .setName('레벨업포인트')
        .setDescription('레벨업할 때마다 주는 포인트 (0=없음)')
        .addIntegerOption((o) => o.setName('포인트').setDescription('레벨 1업당 포인트').setRequired(true).setMinValue(0).setMaxValue(100000)),
    )
    .addSubcommand((s) =>
      s
        .setName('채널배율')
        .setDescription('특정 채널의 XP 배율 (1이면 해제)')
        .addChannelOption((o) => o.setName('채널').setDescription('텍스트/음성 채널').setRequired(true))
        .addNumberOption((o) => o.setName('배').setDescription('0.1 ~ 10').setRequired(true).setMinValue(0.1).setMaxValue(10)),
    )
    .addSubcommand((s) =>
      s
        .setName('역할배율')
        .setDescription('특정 역할(부스터 등)의 XP 배율 (1이면 해제)')
        .addRoleOption((o) => o.setName('역할').setDescription('대상 역할').setRequired(true))
        .addNumberOption((o) => o.setName('배').setDescription('1 ~ 10').setRequired(true).setMinValue(1).setMaxValue(10)),
    )
    .addSubcommand((s) => s.setName('초기화').setDescription('이 서버의 설정을 모두 기본값으로 되돌려요')),
  async (i) => {
    const sub = i.options.getSubcommand();
    const g = i.guildId;

    if (sub === '초기화') {
      const row = (d) =>
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('yes').setLabel('초기화').setStyle(ButtonStyle.Danger).setDisabled(d),
          new ButtonBuilder().setCustomId('no').setLabel('취소').setStyle(ButtonStyle.Secondary).setDisabled(d),
        );
      const msg = await i.reply({
        content: '⚠️ XP 범위·쿨다운·역할 보상·상점 상품 등 **모든 설정이 기본값**으로 돌아가요. (XP/포인트 기록은 유지) 진행할까요?',
        components: [row(false)],
        fetchReply: true,
      });
      const res = await msg.awaitMessageComponent({ filter: (b) => b.user.id === i.user.id, time: 30_000 }).catch(() => null);
      if (!res || res.customId === 'no') {
        if (res) return res.update({ content: '취소했어요.', components: [] });
        return i.editReply({ content: '시간이 지나 취소됐어요.', components: [] }).catch(() => {});
      }
      await S.saveConfig(g, { ...S.DEFAULT_CONFIG });
      return res.update({ content: '✅ 설정을 기본값으로 되돌렸어요.', components: [] });
    }

    if (sub === '보기') {
      const c = await S.getConfig(g);
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('⚙️ 현재 설정')
        .addFields(
          { name: '채팅 XP', value: `${c.xpMin}~${c.xpMax} · 쿨다운 ${c.cooldown}초 · ${c.multiplier}배`, inline: false },
          { name: '음성 XP', value: `${c.voiceXp}/분${c.voiceRequireOthers ? ' · 혼자 있으면 제외' : ''}`, inline: false },
          {
            name: '레벨업 알림',
            value: `${c.levelUpEnabled ? '켜짐' : '꺼짐'} · ${c.levelUpChannel ? `<#${c.levelUpChannel}>` : '메시지 쓴 채널'}\n${c.levelUpMessage}`,
            inline: false,
          },
          { name: '출석', value: `${c.attendPoints}P + 연속 ${c.attendBonusPerStreak}P/일 · ${c.attendXp} XP`, inline: false },
          { name: '레벨업 포인트', value: `${c.levelUpPoints} P / 레벨`, inline: true },
          { name: '접두사 명령어', value: c.prefixEnabled ? `켜짐 (\`${c.prefix}\`)` : '꺼짐', inline: true },
          {
            name: '채널 배율',
            value: Object.entries(c.channelMult || {}).map(([id, x]) => `<#${id}> ${x}배`).join('\n') || '없음',
            inline: false,
          },
          {
            name: '역할 배율',
            value: Object.entries(c.roleMult || {}).map(([id, x]) => `<@&${id}> ${x}배`).join('\n') || '없음',
            inline: false,
          },
          { name: '레벨 보상', value: c.rewards.map((r) => `Lv.${r.level} <@&${r.roleId}>`).join('\n') || '없음', inline: false },
          { name: '상점', value: `상품 ${c.shop.length}개 · 알림 채널 ${c.shopLogChannel ? `<#${c.shopLogChannel}>` : '없음'}`, inline: false },
          { name: '무시 채널', value: c.ignoredChannels.map((id) => `<#${id}>`).join(' ') || '없음', inline: false },
          { name: '무시 역할', value: c.ignoredRoles.map((id) => `<@&${id}>`).join(' ') || '없음', inline: false },
        );
      return i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }

    let text = '✅ 저장했어요.';
    await S.updateConfig(g, (c) => {
      if (sub === 'xp범위') {
        const a = i.options.getInteger('최소');
        const b = i.options.getInteger('최대');
        c.xpMin = Math.min(a, b);
        c.xpMax = Math.max(a, b);
        text = `✅ 메시지당 XP: ${c.xpMin}~${c.xpMax}`;
      } else if (sub === '쿨다운') {
        c.cooldown = i.options.getInteger('초');
        text = `✅ 쿨다운: ${c.cooldown}초`;
      } else if (sub === '배율') {
        c.multiplier = i.options.getNumber('배');
        text = `✅ XP 배율: ${c.multiplier}배`;
      } else if (sub === '음성') {
        c.voiceXp = i.options.getInteger('분당xp');
        const only = i.options.getBoolean('혼자있으면제외');
        if (only !== null) c.voiceRequireOthers = only;
        text = `✅ 음성 XP: ${c.voiceXp}/분${c.voiceRequireOthers ? ' (혼자 있으면 제외)' : ''}`;
      } else if (sub === '레벨업알림') {
        c.levelUpEnabled = i.options.getBoolean('켜기');
        const ch = i.options.getChannel('채널');
        if (ch) c.levelUpChannel = ch.id;
        else if (c.levelUpEnabled === false) c.levelUpChannel = null;
        text = c.levelUpEnabled ? `✅ 레벨업 알림 켜짐 (${c.levelUpChannel ? `<#${c.levelUpChannel}>` : '메시지 쓴 채널'})` : '✅ 레벨업 알림 꺼짐';
      } else if (sub === '레벨업메시지') {
        c.levelUpMessage = i.options.getString('문구');
        text = `✅ 레벨업 문구 저장: ${c.levelUpMessage}`;
      } else if (sub === '무시채널') {
        const ch = i.options.getChannel('채널');
        const has = c.ignoredChannels.includes(ch.id);
        c.ignoredChannels = has ? c.ignoredChannels.filter((x) => x !== ch.id) : [...c.ignoredChannels, ch.id];
        text = has ? `✅ <#${ch.id}> 무시 해제` : `✅ <#${ch.id}> XP 제외`;
      } else if (sub === '무시역할') {
        const role = i.options.getRole('역할');
        const has = c.ignoredRoles.includes(role.id);
        c.ignoredRoles = has ? c.ignoredRoles.filter((x) => x !== role.id) : [...c.ignoredRoles, role.id];
        text = has ? `✅ <@&${role.id}> 무시 해제` : `✅ <@&${role.id}> XP 제외`;
      } else if (sub === '출석') {
        c.attendPoints = i.options.getInteger('포인트');
        const bonus = i.options.getInteger('연속보너스');
        const xp = i.options.getInteger('xp');
        if (bonus !== null) c.attendBonusPerStreak = bonus;
        if (xp !== null) c.attendXp = xp;
        text = `✅ 출석 보상: ${c.attendPoints}P + 연속 ${c.attendBonusPerStreak}P/일, ${c.attendXp} XP`;
      } else if (sub === '접두사') {
        c.prefix = i.options.getString('글자').trim().slice(0, 5) || '!';
        const on = i.options.getBoolean('켜기');
        if (on !== null) c.prefixEnabled = on;
        text = `✅ 접두사: \`${c.prefix}\` (${c.prefixEnabled ? '켜짐' : '꺼짐'}) — 예: ${c.prefix}상점`;
      } else if (sub === '레벨업포인트') {
        c.levelUpPoints = i.options.getInteger('포인트');
        text = `✅ 레벨업할 때마다 ${c.levelUpPoints} P 지급`;
      } else if (sub === '채널배율') {
        const ch = i.options.getChannel('채널');
        const x = i.options.getNumber('배');
        c.channelMult = { ...(c.channelMult || {}) };
        if (x === 1) delete c.channelMult[ch.id];
        else c.channelMult[ch.id] = x;
        text = x === 1 ? `✅ <#${ch.id}> 배율 해제` : `✅ <#${ch.id}> XP ${x}배`;
      } else if (sub === '역할배율') {
        const role = i.options.getRole('역할');
        const x = i.options.getNumber('배');
        c.roleMult = { ...(c.roleMult || {}) };
        if (x === 1) delete c.roleMult[role.id];
        else c.roleMult[role.id] = x;
        text = x === 1 ? `✅ <@&${role.id}> 배율 해제` : `✅ <@&${role.id}> 역할 XP ${x}배`;
      }
    });
    await i.reply({ content: text, allowedMentions: { parse: [] } });
  },
);

// ───────────────────────── /도움말 ─────────────────────────
add(new SlashCommandBuilder().setName('도움말').setDescription('명령어 안내'), async (i) => {
  const cfg = await S.getConfig(i.guildId);
  const p = cfg.prefixEnabled ? cfg.prefix : '!';
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('📖 명령어 안내')
    .setDescription(
      `모든 명령어는 슬래시(\`/랭크\`)와 글자 명령어(\`${p}랭크\`) 둘 다 돼요.${cfg.prefixEnabled ? '' : ' (현재 글자 명령어는 꺼져 있어요)'}\n` +
        '채팅과 음성채널에서 XP를 얻고, 레벨이 오르면 역할·포인트를 받아요.',
    )
    .addFields(
      {
        name: '📊 랭킹',
        value:
          `\`${p}랭크 [@유저]\` 내 레벨·순위\n` +
          `\`${p}리더보드 [종합|채팅|음성] [전체|오늘|이번주|이번달]\` 순위표`,
      },
      {
        name: '💰 출석 · 포인트',
        value: `\`${p}출석\` 하루 1번 포인트\n\`${p}포인트 [@유저]\` 보유 포인트\n\`${p}선물 @유저 금액\` 포인트 보내기`,
      },
      {
        name: '🛒 상점',
        value:
          `\`${p}상점 목록\` · \`${p}상점 정보 번호\`\n` +
          `\`${p}상점 구매 번호 [수량]\`\n` +
          `\`${p}인벤토리 [@유저]\` · \`${p}사용 번호 [수량]\``,
      },
      {
        name: '🔧 관리자 (서버 관리 권한)',
        value:
          `\`${p}설정\` 보기·xp범위·쿨다운·배율·음성·레벨업알림·레벨업메시지·무시채널·무시역할·출석·접두사·레벨업포인트·채널배율·역할배율·초기화\n` +
          `\`${p}레벨역할\` 추가·삭제·목록·누적·동기화\n` +
          `\`${p}상점관리\` 역할추가·아이템추가·xp추가·수정·삭제·목록·로그채널\n` +
          `\`${p}xp\` 지급·차감·설정·초기화·포인트·전체초기화`,
      },
      {
        name: '💡 글자 명령어 쓰는 법',
        value:
          `\`${p}상점관리 역할추가 @VIP 5000 VIP 30\` → 역할, 가격, 이름, 일수 순서로 이어서 써요.\n` +
          `띄어쓰기가 있는 이름은 따옴표로: \`${p}상점관리 아이템추가 "치킨 쿠폰" 3000\`\n` +
          `인자를 빼먹으면 사용법을 알려줘요.`,
      },
    );
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
});

module.exports = { data: data.map((b) => b.toJSON()), handlers };
