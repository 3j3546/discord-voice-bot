// 시간 / 레벨 계산 / 표시용 유틸

const KST_OFFSET = 9 * 60 * 60 * 1000;

function kstDate(ts = Date.now()) {
  return new Date(ts + KST_OFFSET);
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// 한국 시간 기준 오늘 / 이번 주(월요일 시작) / 이번 달 키
function periodKeys(ts = Date.now()) {
  const d = kstDate(ts);
  const day = (d.getUTCDay() + 6) % 7; // 월=0 ... 일=6
  const monday = new Date(d.getTime() - day * 86400000);
  return {
    d: ymd(d),
    w: ymd(monday),
    m: ymd(d).slice(0, 7),
  };
}

function today(ts = Date.now()) {
  return ymd(kstDate(ts));
}

function yesterday(ts = Date.now()) {
  return ymd(kstDate(ts - 86400000));
}

// MEE6 방식: n레벨 -> n+1레벨에 필요한 XP
function xpForNext(level) {
  return 5 * level * level + 50 * level + 100;
}

function levelInfo(totalXp) {
  let level = 0;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (remaining >= xpForNext(level)) {
    remaining -= xpForNext(level);
    level++;
  }
  return { level, current: remaining, needed: xpForNext(level) };
}

function num(n) {
  return Number(n || 0).toLocaleString('ko-KR');
}

function bar(current, total, size = 12) {
  const ratio = total <= 0 ? 0 : Math.min(1, current / total);
  const filled = Math.round(ratio * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

function fmtMinutes(min) {
  min = Math.floor(min || 0);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m}분`;
  return `${h}시간 ${m}분`;
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  periodKeys,
  today,
  yesterday,
  xpForNext,
  levelInfo,
  num,
  bar,
  fmtMinutes,
  rand,
};
