// 디스코드 연결 없이 명령어 정의, 레벨 계산, 글자 명령어 해석이 맞는지 확인
process.env.UPSTASH_REDIS_REST_URL ||= 'https://example.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'x';
const { data, handlers } = require('../commands');
const { levelInfo, xpForNext, periodKeys } = require('../lib/util');
const { tokenize, parseArgs } = require('../prefix');
const S = require('../lib/store');

let ok = true;
const assert = (c, m) => {
  if (!c) {
    ok = false;
    console.error('✗', m);
  } else console.log('✓', m);
};
const def = (n) => data.find((d) => d.name === n);
const parse = (cmd, text) => parseArgs(def(cmd), tokenize(text));

// ── 명령어 정의 ──
assert(data.length === Object.keys(handlers).length, `명령어 ${data.length}개 / 핸들러 일치`);
for (const c of data) {
  assert(/^[\p{L}\p{N}_-]{1,32}$/u.test(c.name) && c.name === c.name.toLowerCase(), `이름 유효: ${c.name}`);
  assert(c.description.length >= 1 && c.description.length <= 100, `설명 길이: ${c.name}`);
  for (const o of c.options ?? []) {
    assert(o.description.length >= 1 && o.description.length <= 100, `  옵션 설명 길이: ${c.name}.${o.name}`);
    for (const p of o.options ?? []) {
      assert(p.description.length >= 1 && p.description.length <= 100, `  옵션 설명 길이: ${c.name}.${o.name}.${p.name}`);
    }
  }
  // 디스코드 규칙: 필수 옵션이 선택 옵션보다 앞에 있어야 해요
  for (const o of c.options ?? []) {
    const list = o.options ?? [];
    const firstOptional = list.findIndex((x) => !x.required);
    const lateRequired = firstOptional >= 0 && list.slice(firstOptional).some((x) => x.required);
    assert(!lateRequired, `필수 옵션 순서: ${c.name}.${o.name}`);
  }
}
for (const need of ['상점', '상점관리', '인벤토리', '사용', '설정', '레벨역할', 'xp', '랭크', '리더보드', '출석', '도움말']) {
  assert(!!def(need), `명령어 존재: ${need}`);
}

// ── 레벨 계산 ──
assert(levelInfo(0).level === 0, '0 XP = 0레벨');
assert(levelInfo(xpForNext(0)).level === 1, '100 XP = 1레벨');
assert(levelInfo(xpForNext(0) + xpForNext(1) - 1).level === 1, '경계값 직전은 1레벨');
const k = periodKeys(Date.UTC(2026, 10, 9, 12));
assert(k.d === '2026-11-09' && k.w === '2026-11-09' && k.m === '2026-11', `기간 키: ${JSON.stringify(k)}`);
const sun = periodKeys(Date.UTC(2026, 10, 15, 12)); // 일요일 -> 주 시작은 그 전 월요일
assert(sun.w === '2026-11-09', `일요일은 월요일 시작 주에 속함: ${sun.w}`);

// ── 글자 명령어 해석 ──
assert(tokenize('상점 구매 1').length === 3, '토큰 분리');
assert(tokenize('아이템추가 "치킨 쿠폰" 3000').join('|') === '아이템추가|치킨 쿠폰|3000', '따옴표 토큰');

let r = parse('상점', '구매 3 2');
assert(r.sub === '구매' && r.values['번호'].value === 3 && r.values['수량'].value === 2, '!상점 구매 3 2');
r = parse('상점', '');
assert(r.sub === '목록', '!상점 (하위 명령어 생략) -> 목록');
r = parse('상점', '구매');
assert(r.error && r.error.includes('사용법'), '!상점 구매 (번호 빠짐) -> 사용법 안내');
r = parse('상점', '구매 abc');
assert(r.error && r.error.includes('숫자'), '숫자가 아니면 안내');
r = parse('상점', '없는명령');
assert(r.error, '모르는 하위 명령어');

r = parse('상점관리', '역할추가 <@&123456789012345678> 5000 VIP 30');
assert(
  r.sub === '역할추가' && r.values['역할'].id === '123456789012345678' && r.values['가격'].value === 5000 && r.values['이름'].value === 'VIP' && r.values['일수'].value === 30,
  '!상점관리 역할추가 @역할 5000 VIP 30',
);
r = parse('상점관리', '아이템추가 "치킨 쿠폰" 3000');
assert(r.sub === '아이템추가' && r.values['이름'].value === '치킨 쿠폰' && r.values['가격'].value === 3000, '!상점관리 아이템추가 "치킨 쿠폰" 3000');
r = parse('상점관리', '아이템추가 치킨쿠폰 3000 5 맛있는 치킨 쿠폰');
assert(r.values['재고'].value === 5 && r.values['설명'].value === '맛있는 치킨 쿠폰', '마지막 글 인자는 띄어쓰기 포함');
r = parse('상점관리', '삭제 2');
assert(r.sub === '삭제' && r.values['번호'].value === 2, '!상점관리 삭제 2');

r = parse('리더보드', '채팅 이번주');
assert(r.values['종류'].value === 'chat' && r.values['기간'].value === 'w', '!리더보드 채팅 이번주');
r = parse('리더보드', '');
assert(!r.error && Object.keys(r.values).length === 0, '!리더보드 (기본값)');
r = parse('리더보드', '이상한값');
assert(r.error, '선택지에 없는 값은 안내');

r = parse('설정', '쿨다운 30');
assert(r.sub === '쿨다운' && r.values['초'].value === 30, '!설정 쿨다운 30');
r = parse('설정', '쿨다운 99999');
assert(r.error && r.error.includes('이하'), '최대값 검사');
r = parse('설정', '음성 10 끄기');
assert(r.values['분당xp'].value === 10 && r.values['혼자있으면제외'].value === false, '!설정 음성 10 끄기');
r = parse('설정', '채널배율 <#123456789012345678> 2');
assert(r.values['채널'].id === '123456789012345678' && r.values['배'].value === 2, '!설정 채널배율 #채널 2');
r = parse('설정', '레벨업메시지 {user}님 {level}레벨 축하해요 🎉');
assert(r.values['문구'].value === '{user}님 {level}레벨 축하해요 🎉', '레벨업 문구는 통째로');
r = parse('랭크', '<@!123456789012345678>');
assert(r.values['유저'].id === '123456789012345678', '!랭크 @유저');
r = parse('xp', '지급 <@123456789012345678> 500');
assert(r.sub === '지급' && r.values['양'].value === 500, '!xp 지급 @유저 500');
r = parse('xp', '전체초기화');
assert(r.sub === '전체초기화', '!xp 전체초기화');
r = parse('선물', '<@123456789012345678> 1,000');
assert(r.values['금액'].value === 1000, '쉼표 숫자 1,000');

// ── 배율 계산 ──
const fakeMember = (roles) => ({ roles: { cache: { has: (id) => roles.includes(id) } } });
const cfg = { ...S.DEFAULT_CONFIG, multiplier: 2, channelMult: { c1: 3 }, roleMult: { r1: 1.5, r2: 2 } };
assert(S.multiplierFor(cfg, fakeMember([]), 'x') === 2, '기본 배율 2배');
assert(S.multiplierFor(cfg, fakeMember([]), 'c1') === 6, '채널 3배 x 서버 2배 = 6');
assert(S.multiplierFor(cfg, fakeMember(['r1', 'r2']), 'x') === 4, '역할 배율은 가장 높은 것 하나만(2) x 서버 2 = 4');
assert(S.multiplierFor({ ...cfg, multiplier: 10, channelMult: { c1: 10 } }, fakeMember(['r2']), 'c1') === 20, '최대 20배 제한');
const thread = S.multiplierFor(cfg, fakeMember([]), 'thread', 'c1');
assert(thread === 6, '스레드는 부모 채널 배율 적용');

process.exit(ok ? 0 : 1);
