// 포인트 상점: 역할(영구/기간제) · 아이템 · XP 상품, 재고, 인벤토리, 사용 요청
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const S = require('./lib/store');
const { num } = require('./lib/util');

const TYPE = { role: '🎭 역할', item: '🎁 아이템', xp: '✨ XP' };
const DAY = 86400000;
const MAX_PRODUCTS = 50;

function shopOf(cfg) {
  // 옛 형식(번호/종류 없음)도 읽을 수 있게 보정
  return cfg.shop.map((p, idx) => ({ id: p.id ?? idx + 1, type: p.type ?? 'role', ...p }));
}

const findItem = (cfg, id) => shopOf(cfg).find((p) => p.id === id);

function line(p, stock) {
  let extra = '';
  if (p.type === 'role') extra = ` <@&${p.roleId}>${p.days ? ` (${p.days}일)` : ' (영구)'}`;
  if (p.type === 'xp') extra = ` +${num(p.xp)} XP`;
  const left = p.limited ? ` · 재고 ${num(stock[p.id] ?? 0)}` : '';
  const desc = p.desc ? `\n　└ ${p.desc}` : '';
  return `**#${p.id}** ${p.name} — **${num(p.price)} P**${extra}${left}${desc}`;
}

async function notify(i, cfg, text) {
  const ch = cfg.shopLogChannel && i.guild.channels.cache.get(cfg.shopLogChannel);
  if (!ch) return false;
  try {
    await ch.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = function registerShop(add, { err, COLOR, ADMIN }) {
  // ───────────── /상점 ─────────────
  add(
    new SlashCommandBuilder()
      .setName('상점')
      .setDescription('포인트로 역할 · 아이템 · XP를 사요')
      .addSubcommand((s) => s.setName('목록').setDescription('상점 목록 보기'))
      .addSubcommand((s) =>
        s
          .setName('정보')
          .setDescription('상품 자세히 보기')
          .addIntegerOption((o) => o.setName('번호').setDescription('상품 번호').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((s) =>
        s
          .setName('구매')
          .setDescription('상품 구매')
          .addIntegerOption((o) => o.setName('번호').setDescription('상품 번호').setRequired(true).setMinValue(1))
          .addIntegerOption((o) => o.setName('수량').setDescription('개수 (아이템·XP만, 기본 1)').setMinValue(1).setMaxValue(99)),
      ),
    async (i) => {
      const g = i.guildId;
      const cfg = await S.getConfig(g);
      const sub = i.options.getSubcommand();
      const items = shopOf(cfg);
      const stock = (await S.redis.hgetall(S.key.stock(g))) || {};

      if (sub === '목록') {
        if (!items.length) return i.reply('아직 등록된 상품이 없어요.');
        const groups = ['role', 'item', 'xp']
          .map((t) => {
            const list = items.filter((p) => p.type === t);
            return list.length ? `### ${TYPE[t]}\n${list.map((p) => line(p, stock)).join('\n')}` : null;
          })
          .filter(Boolean)
          .join('\n\n');
        const embed = new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('🛒 포인트 상점')
          .setDescription(groups.slice(0, 4000))
          .setFooter({ text: `/상점 구매 번호  ·  /상점 정보 번호  ·  포인트는 /출석으로 모아요` });
        return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      }

      const id = i.options.getInteger('번호');
      const item = findItem(cfg, id);
      if (!item) return err(i, '그 번호의 상품이 없어요. `/상점 목록`으로 확인해 보세요.');

      if (sub === '정보') {
        const mine = (await S.getStats(g, i.user.id)).points;
        const embed = new EmbedBuilder()
          .setColor(COLOR)
          .setTitle(`${TYPE[item.type]} #${item.id} ${item.name}`)
          .setDescription(item.desc || '설명이 없어요.')
          .addFields({ name: '가격', value: `${num(item.price)} P`, inline: true }, { name: '내 포인트', value: `${num(mine)} P`, inline: true });
        if (item.type === 'role') embed.addFields({ name: '역할', value: `<@&${item.roleId}> · ${item.days ? `${item.days}일 기간제` : '영구'}`, inline: true });
        if (item.type === 'xp') embed.addFields({ name: '지급 XP', value: `+${num(item.xp)} XP`, inline: true });
        embed.addFields({ name: '재고', value: item.limited ? `${num(stock[item.id] ?? 0)}개` : '무제한', inline: true });
        return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      }

      // 구매
      const qty = i.options.getInteger('수량') ?? 1;
      if (item.type === 'role' && qty !== 1) return err(i, '역할은 한 번에 1개만 살 수 있어요.');
      if (item.type === 'role' && !item.days && i.member.roles.cache.has(item.roleId)) return err(i, '이미 가지고 있는 역할이에요.');
      const cost = item.price * qty;
      const hk = S.key.user(g, i.user.id);

      const left = await S.redis.hincrby(hk, 'points', -cost);
      if (left < 0) {
        await S.redis.hincrby(hk, 'points', cost);
        return err(i, `포인트가 부족해요. (필요 ${num(cost)} P · 보유 ${num(left + cost)} P)`);
      }
      const refund = () => S.redis.hincrby(hk, 'points', cost);

      if (item.limited) {
        const r = await S.redis.hincrby(S.key.stock(g), String(item.id), -qty);
        if (r < 0) {
          await S.redis.hincrby(S.key.stock(g), String(item.id), qty);
          await refund();
          return err(i, '재고가 부족해요.');
        }
      }
      const undoStock = () => (item.limited ? S.redis.hincrby(S.key.stock(g), String(item.id), qty) : null);

      let resultText = '';
      try {
        if (item.type === 'role') {
          await i.member.roles.add(item.roleId, '포인트 상점 구매');
          if (item.days) {
            const ek = S.key.exp(g);
            const member = `${i.user.id}:${item.roleId}`;
            const cur = Number(await S.redis.zscore(ek, member)) || 0;
            const until = Math.max(Date.now(), cur) + item.days * DAY;
            await S.redis.zadd(ek, { score: until, member });
            resultText = `<@&${item.roleId}> 역할을 ${item.days}일 동안 쓸 수 있어요. (만료: <t:${Math.floor(until / 1000)}:R>)`;
          } else resultText = `<@&${item.roleId}> 역할을 받았어요!`;
        } else if (item.type === 'xp') {
          const r = await S.addXp(g, i.user.id, item.xp * qty, 'admin');
          await S.handleLevelUp(i.member, r, cfg, i.channel);
          resultText = `**+${num(item.xp * qty)} XP**를 받았어요!`;
        } else {
          await S.redis.hincrby(S.key.inv(g, i.user.id), String(item.id), qty);
          resultText = `인벤토리에 넣었어요. \`/사용 번호:${item.id}\`로 사용할 수 있어요.`;
        }
      } catch (e) {
        await refund();
        await undoStock();
        return err(i, '지급 중 문제가 생겨 포인트를 돌려드렸어요. 봇 역할이 지급할 역할보다 위에 있는지 관리자에게 확인해 달라고 해주세요.');
      }

      await notify(i, cfg, `🛒 <@${i.user.id}>님이 **${item.name}** x${qty} 구매 (-${num(cost)} P)`);
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ 구매 완료')
        .setDescription(`**${item.name}** x${qty}\n${resultText}\n\n-${num(cost)} P · 남은 포인트 **${num(left)} P**`);
      await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    },
  );

  // ───────────── /인벤토리 ─────────────
  add(
    new SlashCommandBuilder()
      .setName('인벤토리')
      .setDescription('가지고 있는 아이템을 확인해요')
      .addUserOption((o) => o.setName('유저').setDescription('확인할 유저')),
    async (i) => {
      const user = i.options.getUser('유저') ?? i.user;
      const cfg = await S.getConfig(i.guildId);
      const inv = (await S.redis.hgetall(S.key.inv(i.guildId, user.id))) || {};
      const rows = Object.entries(inv)
        .filter(([, n]) => Number(n) > 0)
        .map(([id, n]) => {
          const item = findItem(cfg, Number(id));
          return `**#${id}** ${item ? item.name : '(삭제된 상품)'} x${num(n)}`;
        });
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`🎒 ${user.displayName ?? user.username}님의 인벤토리`)
        .setDescription(rows.length ? rows.join('\n') : '비어 있어요.')
        .setFooter({ text: '/사용 번호 로 아이템을 써요' });
      await i.reply({ embeds: [embed] });
    },
  );

  // ───────────── /사용 ─────────────
  add(
    new SlashCommandBuilder()
      .setName('사용')
      .setDescription('아이템을 사용해요 (관리자에게 알림이 가요)')
      .addIntegerOption((o) => o.setName('번호').setDescription('아이템 번호').setRequired(true).setMinValue(1))
      .addIntegerOption((o) => o.setName('수량').setDescription('개수 (기본 1)').setMinValue(1).setMaxValue(99)),
    async (i) => {
      const g = i.guildId;
      const cfg = await S.getConfig(g);
      const id = i.options.getInteger('번호');
      const qty = i.options.getInteger('수량') ?? 1;
      const item = findItem(cfg, id);
      if (!item || item.type !== 'item') return err(i, '사용할 수 있는 아이템 번호가 아니에요.');
      if (!cfg.shopLogChannel || !i.guild.channels.cache.get(cfg.shopLogChannel)) {
        return err(i, '아직 관리자가 알림 채널을 설정하지 않아서 사용할 수 없어요. 관리자에게 문의해 주세요.');
      }
      const ik = S.key.inv(g, i.user.id);
      const left = await S.redis.hincrby(ik, String(id), -qty);
      if (left < 0) {
        await S.redis.hincrby(ik, String(id), qty);
        return err(i, '보유 수량이 부족해요.');
      }
      const ok = await notify(i, cfg, `🎁 <@${i.user.id}>님이 **${item.name}** x${qty}를 사용했어요. 처리해 주세요! (<#${i.channelId}>)`);
      if (!ok) {
        await S.redis.hincrby(ik, String(id), qty);
        return err(i, '관리자에게 알리지 못해서 사용을 취소했어요. (봇이 알림 채널에 글을 쓸 수 있는지 확인이 필요해요)');
      }
      await i.reply(`✅ **${item.name}** x${qty} 사용! 관리자에게 알렸어요. 남은 수량: ${num(left)}개`);
    },
  );

  // ───────────── /상점관리 ─────────────
  const priceOpt = (o) => o.setName('가격').setDescription('포인트 가격').setRequired(true).setMinValue(0);
  const nameOpt = (o) => o.setName('이름').setDescription('상품 이름').setMaxLength(40);
  const stockOpt = (o) => o.setName('재고').setDescription('한정 수량 (생략=무제한)').setMinValue(1);
  const descOpt = (o) => o.setName('설명').setDescription('상품 설명').setMaxLength(100);

  async function addProduct(g, base, stock) {
    let created;
    await S.updateConfig(g, (c) => {
      const next = Math.max(c.shopSeq || 0, ...c.shop.map((p) => p.id || 0)) + 1;
      c.shopSeq = next;
      created = { id: next, ...base, limited: stock !== null };
      c.shop = [...c.shop, created];
    });
    if (stock !== null) await S.redis.hset(S.key.stock(g), { [String(created.id)]: String(stock) });
    return created;
  }

  add(
    new SlashCommandBuilder()
      .setName('상점관리')
      .setDescription('포인트 상점 상품을 관리해요 (관리자)')
      .setDefaultMemberPermissions(ADMIN)
      .setContexts(0)
      .addSubcommand((s) =>
        s
          .setName('역할추가')
          .setDescription('역할 상품 추가 (일수를 주면 기간제)')
          .addRoleOption((o) => o.setName('역할').setDescription('판매할 역할').setRequired(true))
          .addIntegerOption(priceOpt)
          .addStringOption(nameOpt)
          .addIntegerOption((o) => o.setName('일수').setDescription('기간제 일수 (생략=영구)').setMinValue(1).setMaxValue(3650))
          .addIntegerOption(stockOpt)
          .addStringOption(descOpt),
      )
      .addSubcommand((s) =>
        s
          .setName('아이템추가')
          .setDescription('아이템 상품 추가 (사려면 /사용으로 관리자에게 알림)')
          .addStringOption((o) => nameOpt(o).setRequired(true))
          .addIntegerOption(priceOpt)
          .addIntegerOption(stockOpt)
          .addStringOption(descOpt),
      )
      .addSubcommand((s) =>
        s
          .setName('xp추가')
          .setDescription('XP를 파는 상품 추가')
          .addIntegerOption((o) => o.setName('양').setDescription('지급할 XP').setRequired(true).setMinValue(1))
          .addIntegerOption(priceOpt)
          .addStringOption(nameOpt)
          .addIntegerOption(stockOpt),
      )
      .addSubcommand((s) =>
        s
          .setName('수정')
          .setDescription('상품 수정')
          .addIntegerOption((o) => o.setName('번호').setDescription('상품 번호').setRequired(true).setMinValue(1))
          .addIntegerOption((o) => o.setName('가격').setDescription('새 가격').setMinValue(0))
          .addStringOption(nameOpt)
          .addStringOption(descOpt)
          .addIntegerOption((o) => o.setName('재고').setDescription('남은 재고 (-1 = 무제한으로 변경)').setMinValue(-1)),
      )
      .addSubcommand((s) =>
        s
          .setName('삭제')
          .setDescription('상품 삭제')
          .addIntegerOption((o) => o.setName('번호').setDescription('상품 번호').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((s) => s.setName('목록').setDescription('상품 전체 보기 (설정 확인용)'))
      .addSubcommand((s) =>
        s
          .setName('로그채널')
          .setDescription('구매/사용 알림 채널 (생략하면 해제)')
          .addChannelOption((o) => o.setName('채널').setDescription('알림 받을 채널').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      ),
    async (i) => {
      const g = i.guildId;
      const sub = i.options.getSubcommand();
      const cfg0 = await S.getConfig(g);

      if (['역할추가', '아이템추가', 'xp추가'].includes(sub) && cfg0.shop.length >= MAX_PRODUCTS) {
        return err(i, `상품은 최대 ${MAX_PRODUCTS}개까지 등록할 수 있어요.`);
      }

      if (sub === '역할추가') {
        const role = i.options.getRole('역할');
        if (role.managed || role.id === i.guildId) return err(i, '그 역할은 상품으로 쓸 수 없어요.');
        const p = await addProduct(
          g,
          {
            type: 'role',
            name: i.options.getString('이름') ?? role.name,
            price: i.options.getInteger('가격'),
            roleId: role.id,
            days: i.options.getInteger('일수') ?? null,
            desc: i.options.getString('설명') ?? '',
          },
          i.options.getInteger('재고'),
        );
        return i.reply({ content: `✅ 상품 #${p.id} 등록: <@&${role.id}> ${num(p.price)} P${p.days ? ` (${p.days}일)` : ''}`, allowedMentions: { parse: [] } });
      }
      if (sub === '아이템추가') {
        const p = await addProduct(
          g,
          {
            type: 'item',
            name: i.options.getString('이름'),
            price: i.options.getInteger('가격'),
            desc: i.options.getString('설명') ?? '',
          },
          i.options.getInteger('재고'),
        );
        return i.reply(`✅ 아이템 #${p.id} 등록: ${p.name} ${num(p.price)} P${cfg0.shopLogChannel ? '' : '\n⚠️ `/상점관리 로그채널`로 알림 채널을 정해야 `/사용`이 동작해요.'}`);
      }
      if (sub === 'xp추가') {
        const xp = i.options.getInteger('양');
        const p = await addProduct(
          g,
          { type: 'xp', name: i.options.getString('이름') ?? `XP ${num(xp)}`, price: i.options.getInteger('가격'), xp, desc: '' },
          i.options.getInteger('재고'),
        );
        return i.reply(`✅ XP 상품 #${p.id} 등록: ${p.name} (+${num(xp)} XP) ${num(p.price)} P`);
      }

      if (sub === '로그채널') {
        const ch = i.options.getChannel('채널');
        await S.updateConfig(g, (c) => {
          c.shopLogChannel = ch ? ch.id : null;
        });
        return i.reply(ch ? `✅ 구매/사용 알림 채널: <#${ch.id}>` : '✅ 알림 채널을 해제했어요. (아이템 `/사용`은 막혀요)');
      }

      if (sub === '목록') {
        const stock = (await S.redis.hgetall(S.key.stock(g))) || {};
        const items = shopOf(cfg0);
        const embed = new EmbedBuilder()
          .setColor(COLOR)
          .setTitle('🛠️ 상점 상품 전체')
          .setDescription(items.length ? items.map((p) => `${TYPE[p.type]} ${line(p, stock)}`).join('\n').slice(0, 4000) : '등록된 상품이 없어요.')
          .setFooter({ text: `알림 채널: ${cfg0.shopLogChannel ? '설정됨' : '없음'}` });
        return i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      }

      const id = i.options.getInteger('번호');
      const item = findItem(cfg0, id);
      if (!item) return err(i, '그 번호의 상품이 없어요.');

      if (sub === '삭제') {
        await S.updateConfig(g, (c) => {
          c.shop = shopOf(c).filter((p) => p.id !== id);
        });
        await S.redis.hdel(S.key.stock(g), String(id));
        return i.reply(`🗑️ 상품 #${id} ${item.name}을(를) 삭제했어요. (이미 산 사람의 인벤토리는 그대로예요)`);
      }

      // 수정
      const price = i.options.getInteger('가격');
      const name = i.options.getString('이름');
      const desc = i.options.getString('설명');
      const stock = i.options.getInteger('재고');
      await S.updateConfig(g, (c) => {
        c.shop = shopOf(c).map((p) => {
          if (p.id !== id) return p;
          const n = { ...p };
          if (price !== null) n.price = price;
          if (name !== null) n.name = name;
          if (desc !== null) n.desc = desc;
          if (stock !== null) n.limited = stock !== -1;
          return n;
        });
      });
      if (stock !== null) {
        if (stock === -1) await S.redis.hdel(S.key.stock(g), String(id));
        else await S.redis.hset(S.key.stock(g), { [String(id)]: String(stock) });
      }
      await i.reply(`✅ 상품 #${id} 수정 완료`);
    },
  );
};
