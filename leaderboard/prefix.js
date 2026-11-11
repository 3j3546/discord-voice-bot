// 글자(접두사) 명령어: "!상점 구매 1" 같은 메시지를 슬래시 명령어와 같은 핸들러로 실행
// 슬래시 명령어 정의(JSON)를 읽어서 인자를 순서대로 채워 넣어요.
const { PermissionFlagsBits } = require('discord.js');

const T = { SUB: 1, GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10 };

// 다른 이름으로도 부를 수 있게
const ALIASES = {
  순위: '랭크',
  레벨: '랭크',
  랭킹: '리더보드',
  리더: '리더보드',
  지갑: '포인트',
  가방: '인벤토리',
  인벤: '인벤토리',
  도움: '도움말',
  help: '도움말',
  rank: '랭크',
  top: '리더보드',
  shop: '상점',
};

// 일부 선택지는 말투를 넓게 받아줘요 (예: 이번주 = 이번 주(월~일))
const CHOICE_ALIASES = {
  all: ['전체', '모두', '전부'],
  d: ['오늘', '일간', '일'],
  w: ['이번주', '주간', '주', '이번 주'],
  m: ['이번달', '월간', '월', '이번 달'],
  total: ['종합', '전체', '합계'],
  chat: ['채팅', '글', '메시지'],
  voice: ['음성', '보이스', '통화'],
};

const TRUE_WORDS = ['켜기', '켬', '켜', 'on', 'true', 'yes', 'y', '1', '예', '네', 'ㅇ', '응', '허용'];
const FALSE_WORDS = ['끄기', '끔', '꺼', 'off', 'false', 'no', 'n', '0', '아니', '아니오', 'ㄴ', '해제'];

function tokenize(text) {
  const out = [];
  const re = /"([^"]*)"|“([^”]*)”|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

const idOf = (s, re) => {
  const m = s.match(re);
  if (m) return m[1];
  return /^\d{15,22}$/.test(s) ? s : null;
};
const userId = (s) => idOf(s, /^<@!?(\d+)>$/);
const roleId = (s) => idOf(s, /^<@&(\d+)>$/);
const channelId = (s) => idOf(s, /^<#(\d+)>$/);

function typeHint(o) {
  if (o.choices?.length) return o.choices.map((c) => c.name).join('|');
  return { [T.STRING]: '글', [T.INTEGER]: '숫자', [T.NUMBER]: '숫자', [T.BOOLEAN]: '켜기/끄기', [T.USER]: '@유저', [T.CHANNEL]: '#채널', [T.ROLE]: '@역할' }[o.type] ?? '값';
}

function usage(prefix, def, sub) {
  const opts = (sub ? sub.options : def.options) ?? [];
  const parts = opts
    .filter((o) => o.type !== T.SUB)
    .map((o) => (o.required ? `<${o.name}:${typeHint(o)}>` : `[${o.name}:${typeHint(o)}]`));
  return `${prefix}${def.name}${sub ? ` ${sub.name}` : ''} ${parts.join(' ')}`.trim();
}

function matchChoice(o, raw) {
  const low = raw.toLowerCase();
  for (const c of o.choices) {
    const names = [c.name, String(c.value), ...(CHOICE_ALIASES[c.value] ?? [])].map((x) => x.toLowerCase());
    if (names.includes(low)) return c.value;
  }
  return null;
}

/**
 * 명령어 정의 + 토큰 -> { sub, values } (값은 아직 ID 상태) 또는 { error }
 * 순수 함수라서 디스코드 없이 테스트할 수 있어요.
 */
function parseArgs(def, tokens, prefix = '!') {
  let optDefs = def.options ?? [];
  let sub = null;
  const subs = optDefs.filter((o) => o.type === T.SUB);
  if (subs.length) {
    const found = subs.find((s) => s.name === tokens[0]);
    if (found) {
      sub = found;
      tokens = tokens.slice(1);
    } else if (!tokens.length) {
      sub = subs.find((s) => ['목록', '보기'].includes(s.name)) ?? null;
      if (!sub) return { error: `하위 명령어를 적어 주세요: ${subs.map((s) => s.name).join(', ')}\n예) \`${prefix}${def.name} ${subs[0].name}\`` };
    } else {
      return { error: `알 수 없는 하위 명령어예요: ${subs.map((s) => s.name).join(', ')}` };
    }
    optDefs = sub.options ?? [];
  }

  const values = {};
  let pos = 0;
  for (let idx = 0; idx < optDefs.length; idx++) {
    const o = optDefs[idx];
    if (pos >= tokens.length) {
      if (o.required) return { error: `인자가 부족해요.\n사용법: \`${usage(prefix, def, sub)}\``, usageText: usage(prefix, def, sub) };
      continue;
    }
    const isLast = idx === optDefs.length - 1;
    let raw;
    if (o.type === T.STRING && isLast && !o.choices?.length) {
      raw = tokens.slice(pos).join(' ');
      pos = tokens.length;
    } else {
      raw = tokens[pos++];
    }
    const bad = (why) => ({ error: `\`${o.name}\` ${why}\n사용법: \`${usage(prefix, def, sub)}\`` });

    switch (o.type) {
      case T.STRING: {
        if (o.choices?.length) {
          const v = matchChoice(o, raw);
          if (v === null) return bad(`은(는) 이 중에서 골라 주세요: ${o.choices.map((c) => c.name).join(', ')}`);
          values[o.name] = { type: o.type, value: v };
        } else {
          if (o.max_length && raw.length > o.max_length) return bad(`은(는) ${o.max_length}자 이하로 써 주세요.`);
          values[o.name] = { type: o.type, value: raw };
        }
        break;
      }
      case T.INTEGER:
      case T.NUMBER: {
        const n = Number(raw.replace(/,/g, ''));
        if (!Number.isFinite(n) || (o.type === T.INTEGER && !Number.isInteger(n))) return bad('은(는) 숫자로 써 주세요.');
        if (o.min_value !== undefined && n < o.min_value) return bad(`은(는) ${o.min_value} 이상이어야 해요.`);
        if (o.max_value !== undefined && n > o.max_value) return bad(`은(는) ${o.max_value} 이하여야 해요.`);
        values[o.name] = { type: o.type, value: n };
        break;
      }
      case T.BOOLEAN: {
        const low = raw.toLowerCase();
        if (TRUE_WORDS.includes(low)) values[o.name] = { type: o.type, value: true };
        else if (FALSE_WORDS.includes(low)) values[o.name] = { type: o.type, value: false };
        else return bad('은(는) 켜기/끄기로 써 주세요.');
        break;
      }
      case T.USER:
      case T.CHANNEL:
      case T.ROLE: {
        const id = o.type === T.USER ? userId(raw) : o.type === T.ROLE ? roleId(raw) : channelId(raw);
        if (!id) return bad(`은(는) ${o.type === T.USER ? '@유저를 멘션' : o.type === T.ROLE ? '@역할을 멘션' : '#채널을 멘션'}해 주세요.`);
        values[o.name] = { type: o.type, id };
        break;
      }
      default:
        values[o.name] = { type: o.type, value: raw };
    }
  }
  if (pos < tokens.length && !(optDefs.length && optDefs[optDefs.length - 1].type === T.STRING)) {
    // 남는 인자는 무시해요 (오타로 막지 않기)
  }
  return { sub: sub?.name ?? null, subDef: sub, values };
}

// 멘션 ID -> 실제 객체
async function resolveValues(message, values) {
  const out = {};
  for (const [name, v] of Object.entries(values)) {
    if (v.id === undefined) {
      out[name] = v.value;
      continue;
    }
    if (v.type === T.USER) {
      out[name] = await message.client.users.fetch(v.id).catch(() => null);
      if (!out[name]) return { error: '그 유저를 찾을 수 없어요.' };
    } else if (v.type === T.ROLE) {
      out[name] = message.guild.roles.cache.get(v.id) ?? (await message.guild.roles.fetch(v.id).catch(() => null));
      if (!out[name]) return { error: '그 역할을 찾을 수 없어요.' };
    } else {
      out[name] = message.guild.channels.cache.get(v.id) ?? (await message.guild.channels.fetch(v.id).catch(() => null));
      if (!out[name]) return { error: '그 채널을 찾을 수 없어요.' };
    }
  }
  return { values: out };
}

// 슬래시 인터랙션처럼 동작하는 가짜 객체
function makeInteraction(message, def, subName, values) {
  let sent = null;
  const clean = (opts) => {
    const o = typeof opts === 'string' ? { content: opts } : { ...opts };
    delete o.flags; // 비공개(ephemeral)는 글자 명령어에서는 불가
    delete o.fetchReply;
    o.allowedMentions = { repliedUser: false, ...(o.allowedMentions ?? {}) };
    return o;
  };
  const get = (n) => (values[n] === undefined ? null : values[n]);
  const i = {
    commandName: def.name,
    client: message.client,
    user: message.author,
    member: message.member,
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    channelId: message.channelId,
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => subName,
      getString: get,
      getInteger: get,
      getNumber: get,
      getBoolean: get,
      getUser: get,
      getChannel: get,
      getRole: get,
    },
    async deferReply() {
      i.deferred = true;
      message.channel.sendTyping().catch(() => {});
    },
    async reply(opts) {
      i.replied = true;
      sent = await message.reply(clean(opts)).catch(() => message.channel.send(clean(opts)));
      return sent;
    },
    async editReply(opts) {
      i.replied = true;
      if (!sent) sent = await message.reply(clean(opts)).catch(() => message.channel.send(clean(opts)));
      else sent = await sent.edit(clean(opts));
      return sent;
    },
    async followUp(opts) {
      return message.channel.send(clean(opts));
    },
  };
  return i;
}

function isAllowed(message, def) {
  if (!def.default_member_permissions) return true;
  return message.member.permissions.has(BigInt(def.default_member_permissions)) || message.member.permissions.has(PermissionFlagsBits.Administrator);
}

const lastUse = new Map();

/** 처리했으면 true (등록된 명령어), 아니면 false (다른 봇 명령어 등은 무시) */
async function handlePrefix(message, cfg, defs, handlers) {
  const body = message.content.slice(cfg.prefix.length).trim();
  if (!body) return false;
  const tokens = tokenize(body);
  const name = ALIASES[tokens[0]?.toLowerCase()] ?? tokens[0];
  const def = defs.find((d) => d.name === name);
  if (!def || !handlers[def.name]) return false;

  // 도배 방지 (1.5초)
  const ck = `${message.guildId}:${message.author.id}`;
  if (Date.now() - (lastUse.get(ck) ?? 0) < 1500) return true;
  lastUse.set(ck, Date.now());

  const send = (text) => message.reply({ content: text, allowedMentions: { repliedUser: false } }).catch(() => {});
  if (!isAllowed(message, def)) {
    await send('⚠️ 이 명령어는 서버 관리 권한이 있어야 쓸 수 있어요.');
    return true;
  }
  const parsed = parseArgs(def, tokens.slice(1), cfg.prefix);
  if (parsed.error) {
    await send(`⚠️ ${parsed.error}`);
    return true;
  }
  const resolved = await resolveValues(message, parsed.values);
  if (resolved.error) {
    await send(`⚠️ ${resolved.error}`);
    return true;
  }
  const i = makeInteraction(message, def, parsed.sub, resolved.values);
  try {
    await handlers[def.name](i);
  } catch (e) {
    console.error(`${cfg.prefix}${def.name} 오류:`, e);
    await send('⚠️ 처리 중 오류가 났어요. 잠시 뒤 다시 시도해 주세요.');
  }
  return true;
}

module.exports = { tokenize, parseArgs, usage, handlePrefix, ALIASES, T };
