require('dotenv').config();

// Render 같은 컨테이너 환경에서는 IPv6 경로가 막혀있는데 Node가 IPv6를 먼저
// 시도하다가 응답도 에러도 없이 그냥 멈춰버리는(hang) 경우가 있습니다.
// (에러 로그가 하나도 안 찍히면서 로그인이 영원히 안 끝나는 지금 증상과 정확히
// 일치합니다.) IPv4를 먼저 쓰도록 강제해서 이 문제를 우회합니다.
try {
  require('dns').setDefaultResultOrder('ipv4first');
  console.log('🌐 네트워크 조회 순서를 IPv4 우선으로 설정했어요.');
} catch (error) {
  console.error('⚠️ DNS 우선순위 설정 실패(무시하고 계속 진행합니다):', error.message);
}

// 외부 라이브러리에서 예기치 못한 오류가 나도
// 봇 전체(입퇴장 안내 포함)가 죽지 않도록 안전장치를 겁니다.
process.on('uncaughtException', (error) => {
  console.error('⚠️ 처리되지 않은 예외 발생 (봇은 계속 실행됩니다):', error.stack || error);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ 처리되지 않은 Promise 거부 발생 (봇은 계속 실행됩니다):', (reason && reason.stack) || reason);
});

const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// 외부 API가 응답을 안 주고 멈춰버리는(행) 경우를 대비해,
// 일정 시간(기본 8초)이 지나면 강제로 실패 처리하는 fetch 래퍼입니다.
// 이게 없으면 fetch가 영원히 안 끝나서 슬래시 명령어가 "응답 없음" 상태로 멈춰버릴 수 있습니다.
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`요청이 ${timeoutMs / 1000}초 안에 응답하지 않아 취소했어요.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ===== 기본 음성 설정 (/목소리, /속도 명령어로 서버별로 바꿀 수 있습니다) =====
const DEFAULT_VOICE = 'ko-KR-InJoonNeural'; // 남자 목소리. 여자 목소리는 'ko-KR-SunHiNeural'
const DEFAULT_RATE = 25; // 기본 속도(%). 0이 보통 속도, 25면 25% 빠르게
// ======================================================================

// Render 같은 무료 웹 호스팅은 일정 시간 요청이 없으면 서버를 재웁니다.
// 외부에서 주기적으로 핑을 보낼 수 있는 아주 작은 웹 서버를 하나 띄워서 이를 방지합니다.
// (디스코드 봇 동작 자체와는 무관합니다.)
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive');
  })
  .listen(PORT, () => {
    console.log(`(참고) 깨어있음 확인용 웹서버가 ${PORT} 포트에서 대기 중입니다.`);
  });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 끝말잇기 채팅 내용을 읽기 위해 필요
  ],
  // 디스코드 REST API(deferReply/reply 등)로 나가는 요청이 네트워크 문제로
  // 응답도 에러도 없이 멈춰버리는(hang) 경우를 대비해, 일정 시간 지나면
  // 강제로 실패 처리하도록 타임아웃을 짧게 잡습니다. 기본값은 훨씬 길어서
  // 문제가 생겨도 몇 분씩 조용히 멈춰있을 수 있습니다.
  rest: { timeout: 10_000 },
});

// 길드(서버)별 목소리/속도 설정을 저장합니다.
// 주의: 메모리에만 저장되므로 봇이 재시작되면 기본값으로 초기화됩니다.
const guildSettings = new Map();

// 채널별로 가장 최근에 만든 투표 메시지 ID를 기억합니다 (/투표종료에서 사용).
const activePolls = new Map();

// ===== 끝말잇기 =====
// 채널별 게임 상태: { active, lastWord, usedWords: Set }
const wordChainGames = new Map();

// ===== 가위바위보 =====
// 채널별 상태: { players: Map(userId -> { choice, username }) }
const rpsGames = new Map();

const RPS_LABELS = { scissors: '가위 ✂️', rock: '바위 ✊', paper: '보 ✋' };
const RPS_BEATS = { scissors: 'paper', rock: 'scissors', paper: 'rock' }; // key가 value를 이김

function buildRpsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rps_scissors').setLabel('가위').setEmoji('✂️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('rps_rock').setLabel('바위').setEmoji('✊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('rps_paper').setLabel('보').setEmoji('✋').setStyle(ButtonStyle.Secondary),
  );
}

// 한글 한 글자를 초성/중성/종성으로 분해합니다 (두음법칙 처리에 사용).
const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
const CHOSEONG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JUNGSEONG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];

function isHangulSyllable(char) {
  const code = char.charCodeAt(0);
  return code >= HANGUL_START && code <= HANGUL_END;
}

function decompose(char) {
  const code = char.charCodeAt(0) - HANGUL_START;
  return { cho: CHOSEONG[Math.floor(code / 588)], jung: JUNGSEONG[Math.floor((code % 588) / 28)] };
}

// 두음법칙: 낱말 앞에서 ㄴ/ㄹ이 ㅇ/ㄴ으로 바뀌는 경우를 같이 허용합니다.
// 예: '~력' 다음에 '역', '~녀' 다음에 '여' 로 시작해도 인정.
function getAcceptableStartChars(lastChar) {
  if (!isHangulSyllable(lastChar)) return [lastChar];
  const { cho, jung } = decompose(lastChar);
  const accepted = new Set([lastChar]);

  const rules = [
    { from: 'ㄹ', to: 'ㄴ' },
    { from: 'ㄹ', to: 'ㅇ' },
    { from: 'ㄴ', to: 'ㅇ' },
  ];
  for (const rule of rules) {
    if (cho === rule.from) {
      const code =
        HANGUL_START + CHOSEONG.indexOf(rule.to) * 588 + JUNGSEONG.indexOf(jung) * 28;
      accepted.add(String.fromCharCode(code));
    }
  }
  return [...accepted];
}

// ===== 국립국어원 표준국어대사전 Open API 연동 =====
const dictWordCache = new Map(); // 단어 -> 실존 여부(boolean)
const dictDeadEndCache = new Map(); // 글자 -> 한방단어(다음 이을 말이 없음) 여부(boolean)

async function fetchDictJson(query, method) {
  const key = process.env.KOREAN_DICT_API_KEY;
  const url = `https://stdict.korean.go.kr/api/search.do?key=${key}&q=${encodeURIComponent(
    query,
  )}&req_type=json&method=${method}&advanced=y&num=100`;

  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`사전 API 응답 오류 (HTTP ${response.status})`);
  const data = await response.json();

  if (data && data.error) {
    throw new Error(`사전 API 오류 (${data.error.error_code}): ${data.error.message}`);
  }
  return data;
}

// API 응답의 item은 결과가 1개면 객체, 여러 개면 배열로 옵니다. 항상 배열로 통일합니다.
function toItemArray(data) {
  const item = data && data.channel && data.channel.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

// 실제로 존재하는 단어인지 확인합니다. API 키가 없으면 항상 통과시킵니다.
async function isRealWord(word) {
  if (dictWordCache.has(word)) return dictWordCache.get(word);
  if (!process.env.KOREAN_DICT_API_KEY) return true;

  try {
    const data = await fetchDictJson(word, 'exact');
    const items = toItemArray(data);
    const exists = items.some((item) => (item.word || '').replace(/-/g, '') === word);
    dictWordCache.set(word, exists);
    return exists;
  } catch (error) {
    console.error('사전 조회 오류(isRealWord):', error.message);
    return true; // API 오류 시에는 막지 않고 통과시킵니다.
  }
}

// 이 글자로 시작하는 다른 단어가 사전에 있는지 확인합니다 (없으면 한방단어).
async function hasFollowingWord(char, wordToExclude) {
  if (dictDeadEndCache.has(char)) return !dictDeadEndCache.get(char);
  if (!process.env.KOREAN_DICT_API_KEY) return true; // API 키가 없으면 한방단어 판정을 하지 않습니다.

  try {
    const data = await fetchDictJson(char, 'start');
    const items = toItemArray(data);
    const hasOther = items.some((item) => {
      const w = (item.word || '').replace(/-/g, '');
      return w.length >= 2 && w !== wordToExclude;
    });
    dictDeadEndCache.set(char, !hasOther);
    return hasOther;
  } catch (error) {
    console.error('사전 조회 오류(hasFollowingWord):', error.message);
    return true;
  }
}

// word가 한방단어(다음 사람이 이을 수 없는 단어)인지 확인합니다.
async function isFinishingWord(word) {
  const lastChar = word[word.length - 1];
  const hasFollowing = await hasFollowingWord(lastChar, word);
  return !hasFollowing;
}

// 반환값: null이면 통과, 문자열이면 실패 사유, { win: true }면 한방단어로 즉시 승리
async function checkWordChain(game, word) {
  if (word.length < 2) return '두 글자 이상이어야 해요.';
  if (!/^[가-힣]+$/.test(word)) return '한글 단어만 가능해요.';
  if (game.usedWords.has(word)) return '이미 나온 단어예요.';

  if (game.lastWord) {
    const lastChar = game.lastWord[game.lastWord.length - 1];
    const firstChar = word[0];
    const accepted = getAcceptableStartChars(lastChar);
    if (!accepted.includes(firstChar)) {
      return `**${lastChar}**(으)로 시작하는 단어를 입력해주세요.`;
    }
  }

  const realWord = await isRealWord(word);
  if (!realWord) return '사전에 없는 단어예요.';

  const finishingWord = await isFinishingWord(word);
  if (finishingWord) {
    if (!game.lastWord) {
      // 첫 단어로는 한방단어를 낼 수 없습니다.
      return '한방단어는 첫 단어로 낼 수 없어요. 다른 단어로 시작해주세요.';
    }
    return { win: true };
  }

  return null; // 통과
}

function getSettings(guildId) {
  if (!guildSettings.has(guildId)) {
    guildSettings.set(guildId, { voice: DEFAULT_VOICE, rate: DEFAULT_RATE });
  }
  return guildSettings.get(guildId);
}

function rateToString(rate) {
  return (rate >= 0 ? '+' : '') + rate + '%';
}

function voiceLabel(voice) {
  return voice === DEFAULT_VOICE ? '남자 (인준)' : '여자 (선희)';
}

// DeepL 번역 API를 이용한 번역.
// DEEPL_API_KEY 환경변수가 필요합니다 (deepl.com에서 무료 가입, 신용카드 불필요,
// 한 달에 500,000자까지 무료). source를 안 주면 한국어 포함 여부로 자동 추정합니다.
async function translateText(text, target, source) {
  const hasKorean = /[\u3131-\uD79D]/.test(text);
  const src = source || (hasKorean ? 'ko' : 'en');
  if (src === target) return text;

  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) {
    throw new Error('번역 기능을 쓰려면 DEEPL_API_KEY 환경변수를 설정해야 해요.');
  }

  // DeepL은 언어 코드를 대문자로 쓰고, 중국어는 zh-CN이 아니라 ZH로 씁니다.
  const deeplLang = (code) => (code === 'zh-CN' ? 'ZH' : code.toUpperCase());

  // 무료 키는 뒤에 ":fx"가 붙고, 유료 키는 안 붙습니다. 붙어있는 키를 쓰면
  // 무료용 엔드포인트(api-free.deepl.com)로, 아니면 유료용(api.deepl.com)으로 보냅니다.
  const isFreeKey = apiKey.endsWith(':fx');
  const endpoint = isFreeKey
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Authorization: `DeepL-Auth-Key ${apiKey}`,
    },
    body: `text=${encodeURIComponent(text)}&source_lang=${deeplLang(src)}&target_lang=${deeplLang(target)}`,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`DeepL 번역 API 오류 (HTTP ${response.status}): ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const translated = data && data.translations && data.translations[0] && data.translations[0].text;
  if (!translated) throw new Error('번역 결과를 받지 못했어요.');
  return translated;
}

// 한국어가 섞인 프롬프트를 영어로 번역합니다 (이미지 생성 모델이 영어를 훨씬 잘 이해하기 때문).
// 실패하면 원문을 그대로 반환합니다.
async function translateToEnglishIfKorean(text) {
  const hasKorean = /[\u3131-\uD79D]/.test(text);
  if (!hasKorean) return text;

  try {
    return await translateText(text, 'en', 'ko');
  } catch (error) {
    console.error('번역 실패:', error.message);
    return text;
  }
}

// ===== 슬래시 명령어 정의 =====
const commands = [
  new SlashCommandBuilder()
    .setName('목소리')
    .setDescription('안내 음성의 목소리를 바꿉니다')
    .addStringOption((option) =>
      option
        .setName('설정')
        .setDescription('남자 또는 여자 목소리')
        .setRequired(true)
        .addChoices(
          { name: '남자 (인준)', value: 'male' },
          { name: '여자 (선희)', value: 'female' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('속도')
    .setDescription('안내 음성의 말하기 속도를 바꿉니다')
    .addIntegerOption((option) =>
      option
        .setName('퍼센트')
        .setDescription('기본 속도 대비 몇 % 빠르게 할지 (-50 ~ 100)')
        .setRequired(true)
        .setMinValue(-50)
        .setMaxValue(100),
    ),
  new SlashCommandBuilder()
    .setName('설정확인')
    .setDescription('현재 목소리/속도 설정을 확인합니다'),
  new SlashCommandBuilder()
    .setName('이미지')
    .setDescription('AI로 이미지를 생성합니다')
    .addStringOption((option) =>
      option
        .setName('프롬프트')
        .setDescription('원하는 이미지에 대한 설명 (영어로 쓰면 더 잘 나와요)')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('투표')
    .setDescription('투표를 만듭니다 (반응으로 투표)')
    .addStringOption((option) =>
      option.setName('질문').setDescription('투표 주제').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('항목1').setDescription('첫 번째 선택지').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('항목2').setDescription('두 번째 선택지').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('항목3').setDescription('세 번째 선택지').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('항목4').setDescription('네 번째 선택지').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('항목5').setDescription('다섯 번째 선택지').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('투표종료')
    .setDescription('이 채널의 가장 최근 투표를 마감하고 결과를 보여줍니다'),
  new SlashCommandBuilder()
    .setName('끝말잇기시작')
    .setDescription('이 채널에서 끝말잇기를 시작합니다'),
  new SlashCommandBuilder()
    .setName('끝말잇기종료')
    .setDescription('이 채널의 끝말잇기를 종료합니다'),
  new SlashCommandBuilder()
    .setName('가위바위보')
    .setDescription('버튼으로 진행하는 가위바위보 (최대 2명)'),
  new SlashCommandBuilder()
    .setName('날씨')
    .setDescription('특정 지역의 오늘 날씨를 알려줍니다')
    .addStringOption((option) =>
      option.setName('지역').setDescription('예: 청주시, 서울, 부산').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('번역')
    .setDescription('텍스트를 원하는 언어로 번역합니다')
    .addStringOption((option) =>
      option.setName('텍스트').setDescription('번역할 내용').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('언어')
        .setDescription('번역할 언어')
        .setRequired(true)
        .addChoices(
          { name: '한국어', value: 'ko' },
          { name: '영어', value: 'en' },
          { name: '일본어', value: 'ja' },
          { name: '중국어', value: 'zh-CN' },
          { name: '스페인어', value: 'es' },
          { name: '프랑스어', value: 'fr' },
          { name: '독일어', value: 'de' },
          { name: '베트남어', value: 'vi' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('점수판')
    .setDescription('오늘의 KBO 야구 경기 점수를 보여줍니다')
    .addStringOption((option) =>
      option
        .setName('구단')
        .setDescription('KBO 구단 선택')
        .setRequired(true)
        .addChoices(
          { name: '두산 베어스', value: '두산' },
          { name: 'LG 트윈스', value: 'LG' },
          { name: '키움 히어로즈', value: '키움' },
          { name: 'SSG 랜더스', value: 'SSG' },
          { name: 'NC 다이노스', value: 'NC' },
          { name: 'KIA 타이거즈', value: 'KIA' },
          { name: '삼성 라이온즈', value: '삼성' },
          { name: '롯데 자이언츠', value: '롯데' },
          { name: '한화 이글스', value: '한화' },
          { name: 'KT 위즈', value: 'KT' },
        ),
    ),
].map((command) => command.toJSON());

async function registerCommandsForGuild(guildId) {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
      body: commands,
    });
  } catch (error) {
    console.error(`슬래시 명령어 등록 실패 (길드 ${guildId}):`, error.message);
  }
}

// 안내가 끝난 뒤 채널을 나가기 전에 대기하는 시간(밀리초)
const LEAVE_DELAY_MS = 3000;

// 길드별로 "잠시 후 나가기" 예약 타이머를 관리합니다.
const disconnectTimers = new Map();

function cancelScheduledLeave(guildId) {
  const timer = disconnectTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(guildId);
  }
}

function scheduleLeave(guildId) {
  cancelScheduledLeave(guildId);
  const timer = setTimeout(() => {
    disconnectTimers.delete(guildId);
    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();
  }, LEAVE_DELAY_MS);
  disconnectTimers.set(guildId, timer);
}

// ===== 입퇴장 안내(TTS) 재생 큐 =====
const guildAudio = new Map();

function getGuildAudio(guildId) {
  if (!guildAudio.has(guildId)) {
    const player = createAudioPlayer();
    const state = { player, queue: [], playing: false };
    guildAudio.set(guildId, state);

    player.on(AudioPlayerStatus.Idle, () => {
      state.playing = false;
      if (state.queue.length > 0) {
        playNext(guildId);
      } else {
        scheduleLeave(guildId);
      }
    });

    player.on('error', (error) => {
      console.error(`[안내 음성 재생 오류] 길드 ${guildId}:`, error.message);
      state.playing = false;
      if (state.queue.length > 0) {
        playNext(guildId);
      } else {
        scheduleLeave(guildId);
      }
    });
  }
  return guildAudio.get(guildId);
}

async function playNext(guildId) {
  const state = guildAudio.get(guildId);
  if (!state || state.playing || state.queue.length === 0) return;

  const text = state.queue.shift();
  state.playing = true;
  const settings = getSettings(guildId);

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(settings.voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    const { audioStream } = tts.toStream(text, { rate: rateToString(settings.rate) });
    const resource = createAudioResource(audioStream, { inputType: StreamType.WebmOpus });
    state.player.play(resource);
  } catch (error) {
    console.error('안내 음성 생성 오류:', error.message);
    state.playing = false;
    playNext(guildId);
  }
}

async function speak(voiceChannel, text) {
  const guildId = voiceChannel.guild.id;

  cancelScheduledLeave(guildId);

  let connection = getVoiceConnection(guildId);
  if (!connection || connection.joinConfig.channelId !== voiceChannel.id) {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    } catch (error) {
      console.error('음성 채널 연결 실패:', error.message);
      connection.destroy();
      return;
    }

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      cancelScheduledLeave(guildId);
    });
  }

  const state = getGuildAudio(guildId);
  connection.subscribe(state.player);
  state.queue.push(text);
  playNext(guildId);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ 로그인 완료: ${c.user.tag}`);

  for (const guild of c.guilds.cache.values()) {
    await registerCommandsForGuild(guild.id);
  }
  console.log('✅ 슬래시 명령어 등록 완료');
});

client.on(Events.GuildCreate, (guild) => {
  registerCommandsForGuild(guild.id);
});

// Render 무료 서버는 일정 시간 요청이 없으면 잠들었다가, 다음 요청이 올 때
// 깨어나는 데 시간이 걸릴 수 있습니다(콜드 스타트). 이 사이 디스코드 인터랙션이
// 도착하면, 봇이 깨어나서 응답하기도 전에 디스코드가 그 인터랙션을 무효화시켜
// "Unknown interaction" 오류가 나고 명령어가 전부 먹통이 됩니다.
// 아래 로그로 실제 원인이 이것인지 확인할 수 있습니다.
client.ws.on('shardDisconnect', () => console.warn('⚠️ 디스코드 연결이 끊겼습니다 (shardDisconnect)'));
client.ws.on('shardReconnecting', () => console.warn('⚠️ 디스코드에 재연결을 시도합니다 (shardReconnecting)'));
client.ws.on('shardResume', () => console.warn('✅ 디스코드 연결이 재개되었습니다 (shardResume)'));
setInterval(() => {
  console.log(`(상태 점검) 디스코드 핑: ${client.ws.ping}ms`);
}, 5 * 60 * 1000);

client.on(Events.InteractionCreate, async (interaction) => {
 try {
  if (interaction.isChatInputCommand()) {
    // 인터랙션이 디스코드에서 생성된 시각과 지금(핸들러 진입 시각)의 차이를 잽니다.
    // 이 값이 이미 2~3초를 넘으면, 봇 코드 문제가 아니라 서버가 잠들어있다가
    // 늦게 깨어난 것(콜드 스타트)이 원인이라는 뜻입니다.
    const delay = Date.now() - interaction.createdTimestamp;
    if (delay > 2000) {
      console.warn(
        `⚠️ 인터랙션(/${interaction.commandName}) 처리 시작이 ${delay}ms 지연됐어요. ` +
          `서버가 잠들어있다가 늦게 깨어났을 가능성이 높아요 (Render 무료 플랜의 콜드 스타트).`,
      );
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('rps_')) {
    if (!interaction.inGuild()) return;
    const game = rpsGames.get(interaction.channelId);
    if (!game) {
      await interaction.reply({ content: '진행 중인 가위바위보가 없어요. `/가위바위보`로 새로 시작해주세요.', ephemeral: true });
      return;
    }

    const choice = interaction.customId.replace('rps_', ''); // scissors | rock | paper
    const userId = interaction.user.id;

    if (!game.players.has(userId) && game.players.size >= 2) {
      await interaction.reply({ content: '이미 두 명이 참가했어요.', ephemeral: true });
      return;
    }

    game.players.set(userId, { choice, username: interaction.user.displayName ?? interaction.user.username });
    await interaction.reply({ content: `${RPS_LABELS[choice]}(을)를 선택했어요!`, ephemeral: true });

    if (game.players.size < 2) return;

    const [[id1, p1], [id2, p2]] = [...game.players.entries()];

    if (p1.choice === p2.choice) {
      game.players.clear();
      await interaction.message.edit({
        content: `🤜🤛 비겼습니다 (둘 다 ${RPS_LABELS[p1.choice]})! 다시 진행할게요.`,
        components: [buildRpsRow()],
      });
      return;
    }

    const winnerIsP1 = RPS_BEATS[p1.choice] === p2.choice;
    const winner = winnerIsP1 ? p1 : p2;
    const loser = winnerIsP1 ? p2 : p1;

    rpsGames.delete(interaction.channelId);
    await interaction.message.edit({
      content: `${winner.username}(${RPS_LABELS[winner.choice]}) vs ${loser.username}(${RPS_LABELS[loser.choice]})\n🏆 **${winner.username}님이 승리하셨습니다.**`,
      components: [],
    });
    return;
  }

  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;

  const member = interaction.member;
  const guildId = interaction.guildId;

  // ===== 설정 명령어 (서버 관리 권한 필요) =====
  if (interaction.commandName === '목소리' || interaction.commandName === '속도') {
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: '이 명령어는 "서버 관리" 권한이 있는 사람만 사용할 수 있어요.',
        ephemeral: true,
      });
      return;
    }

    const settings = getSettings(guildId);

    if (interaction.commandName === '목소리') {
      const choice = interaction.options.getString('설정');
      settings.voice = choice === 'male' ? DEFAULT_VOICE : 'ko-KR-SunHiNeural';
      await interaction.reply({
        content: `목소리를 ${voiceLabel(settings.voice)}로 설정했어요.`,
        ephemeral: true,
      });
    } else {
      const percent = interaction.options.getInteger('퍼센트');
      settings.rate = percent;
      await interaction.reply({
        content: `말하기 속도를 ${rateToString(percent)}로 설정했어요.`,
        ephemeral: true,
      });
    }
    return;
  }

  if (interaction.commandName === '설정확인') {
    const settings = getSettings(guildId);
    await interaction.reply({
      content: `현재 목소리: ${voiceLabel(settings.voice)}\n현재 속도: ${rateToString(settings.rate)}`,
      ephemeral: true,
    });
    return;
  }

  // ===== 이미지 생성 (누구나 사용 가능) =====
  if (interaction.commandName === '이미지') {
    await interaction.deferReply();

    const originalPrompt = interaction.options.getString('프롬프트');
    const prompt = await translateToEnglishIfKorean(originalPrompt);
    const seed = Math.floor(Math.random() * 1_000_000); // 같은 프롬프트라도 매번 다른 이미지가 나오도록
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;

    try {
      // Discord가 URL에서 직접 이미지를 못 가져오는 경우가 있어서,
      // 봇이 이미지를 미리 받아온 뒤 첨부파일로 올립니다.
      const response = await fetchWithTimeout(imageUrl, {}, 20000);
      if (!response.ok) {
        throw new Error(`이미지 서버 응답 오류 (HTTP ${response.status})`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const attachment = new AttachmentBuilder(buffer, { name: 'image.png' });

      const embed = new EmbedBuilder()
        .setTitle(originalPrompt.length > 256 ? originalPrompt.slice(0, 253) + '...' : originalPrompt)
        .setImage('attachment://image.png')
        .setColor(0x5865f2)
        .setFooter({
          text:
            prompt !== originalPrompt
              ? `Pollinations.ai로 생성됨 · 번역: ${prompt}`
              : 'Pollinations.ai로 생성됨',
        });

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (error) {
      console.error('이미지 생성 오류:', error.stack || error);
      await interaction.editReply('이미지를 생성하는 중 오류가 발생했어요. 잠시 후 다시 시도해보세요.');
    }
    return;
  }

  // ===== 투표 (누구나 사용 가능) =====
  if (interaction.commandName === '투표') {
    const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    const question = interaction.options.getString('질문');
    const choices = [1, 2, 3, 4, 5]
      .map((i) => interaction.options.getString(`항목${i}`))
      .filter((choice) => choice !== null);

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${question}`)
      .setDescription(choices.map((choice, i) => `${NUMBER_EMOJIS[i]} ${choice}`).join('\n'))
      .setColor(0x57f287)
      .setFooter({ text: `${interaction.user.displayName ?? interaction.user.username}님이 만든 투표 · /투표종료로 마감할 수 있어요` });

    await interaction.reply({ embeds: [embed] });
    const message = await interaction.fetchReply();
    activePolls.set(interaction.channelId, { messageId: message.id, question, choices });

    for (let i = 0; i < choices.length; i++) {
      try {
        await message.react(NUMBER_EMOJIS[i]);
      } catch (error) {
        console.error('투표 반응 추가 오류:', error.message);
      }
    }
    return;
  }

  if (interaction.commandName === '투표종료') {
    const poll = activePolls.get(interaction.channelId);
    if (!poll) {
      await interaction.reply({ content: '이 채널에 마감할 투표가 없어요.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
      const message = await interaction.channel.messages.fetch(poll.messageId);

      const results = [];
      for (let i = 0; i < poll.choices.length; i++) {
        const reaction = message.reactions.cache.get(NUMBER_EMOJIS[i]);
        const count = reaction ? Math.max(0, reaction.count - 1) : 0; // 봇 자신의 반응 1개는 제외
        results.push({ choice: poll.choices[i], count });
      }

      const maxCount = Math.max(...results.map((r) => r.count));
      const lines = results
        .sort((a, b) => b.count - a.count)
        .map((r) => `${r.count === maxCount && maxCount > 0 ? '🏆 ' : ''}${r.choice}: **${r.count}표**`);

      const resultEmbed = new EmbedBuilder()
        .setTitle(`📊 [마감] ${poll.question}`)
        .setDescription(lines.join('\n'))
        .setColor(0xed4245);

      await interaction.editReply({ embeds: [resultEmbed] });
      activePolls.delete(interaction.channelId);
    } catch (error) {
      console.error('투표 마감 오류:', error.message);
      await interaction.editReply('투표 결과를 집계하는 중 오류가 발생했어요.');
    }
    return;
  }

  if (interaction.commandName === '끝말잇기시작') {
    if (wordChainGames.get(interaction.channelId)?.active) {
      await interaction.reply({ content: '이미 이 채널에서 끝말잇기가 진행 중이에요.', ephemeral: true });
      return;
    }
    wordChainGames.set(interaction.channelId, {
      active: true,
      lastWord: null,
      usedWords: new Set(),
      lastAuthorId: null,
      secondLastAuthorId: null,
    });
    await interaction.reply(
      '🔤 끝말잇기를 시작합니다! 아무 단어나 채팅에 입력해서 시작하세요 (두 글자 이상, 한글만, 한방단어 불가).',
    );
    return;
  }

  if (interaction.commandName === '끝말잇기종료') {
    const game = wordChainGames.get(interaction.channelId);
    if (!game || !game.active) {
      await interaction.reply({ content: '진행 중인 끝말잇기가 없어요.', ephemeral: true });
      return;
    }
    wordChainGames.delete(interaction.channelId);

    if (game.lastAuthorId && game.secondLastAuthorId) {
      await interaction.reply(
        `🔤 끝말잇기를 종료합니다. (총 ${game.usedWords.size}개 단어)\n<@${game.lastAuthorId}>님 승리 🏆 <@${game.secondLastAuthorId}>님 패배`,
      );
    } else {
      await interaction.reply(
        `🔤 끝말잇기를 종료합니다. 총 ${game.usedWords.size}개의 단어가 나왔어요!`,
      );
    }
    return;
  }

  if (interaction.commandName === '가위바위보') {
    if (rpsGames.get(interaction.channelId)) {
      await interaction.reply({ content: '이미 이 채널에서 가위바위보가 진행 중이에요.', ephemeral: true });
      return;
    }
    rpsGames.set(interaction.channelId, { players: new Map() });
    await interaction.reply({
      content: '✂️✊✋ 가위바위보! 아래 버튼을 눌러 선택하세요 (최대 2명 참가).',
      components: [buildRpsRow()],
    });
    return;
  }

  if (interaction.commandName === '날씨') {
    await interaction.deferReply();
    const region = interaction.options.getString('지역');

    try {
      const response = await fetchWithTimeout(
        `https://wttr.in/${encodeURIComponent(region)}?format=j1&lang=ko`,
      );
      if (!response.ok) throw new Error(`날씨 API 응답 오류 (HTTP ${response.status})`);
      const data = await response.json();

      const current = data.current_condition[0];
      const today = data.weather[0];
      const description =
        (current.lang_ko && current.lang_ko[0] && current.lang_ko[0].value) ||
        current.weatherDesc[0].value;

      const closings = [
        '오늘도 좋은 하루 보내세요! ☀️',
        '즐거운 하루 되세요! 😊',
        '행복한 하루 보내세요! 🌈',
        '오늘 하루도 화이팅이에요! 💪',
      ];
      const closing = closings[Math.floor(Math.random() * closings.length)];

      const reply =
        `📍 **${region}**의 오늘 날씨는 **${description}**이에요.\n` +
        `🌡️ 현재 기온 ${current.temp_C}°C (체감 ${current.FeelsLikeC}°C) · 최고 ${today.maxtempC}°C / 최저 ${today.mintempC}°C\n` +
        `💧 습도 ${current.humidity}%\n\n` +
        closing;

      await interaction.editReply(reply);
    } catch (error) {
      console.error('날씨 조회 오류:', error.stack || error);
      await interaction.editReply('날씨 정보를 가져오는 중 오류가 발생했어요. 지역 이름을 다시 확인해보세요.');
    }
    return;
  }

  if (interaction.commandName === '번역') {
    await interaction.deferReply();
    const text = interaction.options.getString('텍스트');
    const targetLang = interaction.options.getString('언어');
    const langLabel = {
      ko: '한국어',
      en: '영어',
      ja: '일본어',
      'zh-CN': '중국어',
      es: '스페인어',
      fr: '프랑스어',
      de: '독일어',
      vi: '베트남어',
    }[targetLang];

    try {
      const translated = await translateText(text, targetLang);
      const embed = new EmbedBuilder()
        .setColor(0x4285f4)
        .addFields(
          { name: '원문', value: text.length > 1024 ? text.slice(0, 1021) + '...' : text },
          { name: `번역 (${langLabel})`, value: translated.length > 1024 ? translated.slice(0, 1021) + '...' : translated },
        );
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('번역 오류:', error.stack || error);
      await interaction.editReply('번역하는 중 오류가 발생했어요. 잠시 후 다시 시도해보세요.');
    }
    return;
  }

  if (interaction.commandName === '점수판') {
    await interaction.deferReply();
    const team = interaction.options.getString('구단');

    try {
      const kstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
      const url = `https://api-gw.sports.naver.com/schedule/games?fields=basic,schedule,baseball&fromDate=${kstDate}&toDate=${kstDate}&upperCategoryId=kbaseball&categoryId=kbo&size=50`;

      const response = await fetchWithTimeout(url);
      if (!response.ok) throw new Error(`데이터 조회 오류 (HTTP ${response.status})`);
      const data = await response.json();
      const games = (data && data.result && data.result.games) || [];

      const game = games.find((g) => {
        const home = (g.homeTeamName || '').toUpperCase();
        const away = (g.awayTeamName || '').toUpperCase();
        return home.includes(team.toUpperCase()) || away.includes(team.toUpperCase());
      });

      if (!game) {
        await interaction.editReply(`오늘 **${team}** 경기가 없거나 정보를 찾을 수 없어요.`);
        console.log('점수판 디버그(경기 못 찾음):', JSON.stringify(games).slice(0, 1500));
        return;
      }

      const statusText = game.statusInfo || game.statusCode || '정보 없음';
      const homeScore = game.homeTeamScore ?? game.homeScore ?? '-';
      const awayScore = game.awayTeamScore ?? game.awayScore ?? '-';

      const embed = new EmbedBuilder()
        .setTitle(`⚾ ${game.awayTeamName} vs ${game.homeTeamName}`)
        .setDescription(
          `**${game.awayTeamName} ${awayScore} : ${homeScore} ${game.homeTeamName}**\n` +
            `상태: ${statusText}` +
            (game.stadium ? `\n구장: ${game.stadium}` : ''),
        )
        .setColor(0xed4245);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('점수판 조회 오류:', error.stack || error);
      await interaction.editReply('경기 정보를 가져오는 중 오류가 발생했어요. 잠시 후 다시 시도해보세요.');
    }
    return;
  }
 } catch (error) {
  // 위 명령어 처리 중 어디선가든 예기치 못한 오류가 나면 여기서 잡습니다.
  // error.message만이 아니라 전체 스택을 찍어서, 다음에 문제가 또 생기면
  // Render 로그에서 정확히 몇 번째 줄에서 터졌는지 바로 알 수 있게 합니다.
  console.error('⚠️ 인터랙션 처리 중 오류:', error.stack || error);
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.');
    } else if (interaction.isRepliable && interaction.isRepliable()) {
      await interaction.reply({ content: '처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.', ephemeral: true });
    }
  } catch (replyError) {
    console.error('⚠️ 오류 응답 전송도 실패:', replyError.message);
  }
 }
});

// 끝말잇기 진행 중인 채널의 일반 채팅 메시지를 감시합니다.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const wordChainGame = wordChainGames.get(message.channelId);
  if (wordChainGame && wordChainGame.active) {
    const word = message.content.trim();
    const result = await checkWordChain(wordChainGame, word);

    if (result === null) {
      wordChainGame.usedWords.add(word);
      wordChainGame.lastWord = word;
      wordChainGame.secondLastAuthorId = wordChainGame.lastAuthorId;
      wordChainGame.lastAuthorId = message.author.id;
      message.react('✅').catch(() => {});
      return;
    }

    if (typeof result === 'object' && result.win) {
      // 한방단어! 낸 사람이 승리, 직전에 단어를 낸 사람이 패배.
      wordChainGames.delete(message.channelId);
      message.react('🏆').catch(() => {});
      message
        .reply({
          content: `**${word}**는 한방단어예요!\n<@${message.author.id}>님 승리 🏆 <@${wordChainGame.lastAuthorId}>님 패배`,
          allowedMentions: { repliedUser: false },
        })
        .catch(() => {});
      return;
    }

    // 실패 사유 문자열
    message.react('❌').catch(() => {});
    message.reply({ content: result, allowedMentions: { repliedUser: false } }).catch(() => {});
    return;
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return; // 봇 자신의 입퇴장은 무시

  const nickname = member.displayName;

  // 새로운 음성채널 입장
  if (!oldState.channelId && newState.channelId) {
    speak(newState.channel, `${nickname}님이 입장했습니다`);
    return;
  }

  // 음성채널에서 완전히 퇴장
  if (oldState.channelId && !newState.channelId) {
    speak(oldState.channel, `${nickname}님이 퇴장했습니다`);
    return;
  }

  // 다른 음성채널로 이동
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    speak(oldState.channel, `${nickname}님이 채널을 이동했습니다`);
    speak(newState.channel, `${nickname}님이 입장했습니다`);
  }
});

// 로그인이 조용히 멈춰버리는 경우를 잡아내기 위한 진단 코드입니다.
// 정상이면 몇 초 안에 "✅ 로그인 완료" 로그가 떠야 합니다. 이게 안 뜨면
// 아래에서 "로그인이 000초가 지나도 완료되지 않았어요" 경고가 대신 뜨면서
// DISCORD_TOKEN이 잘못됐거나 네트워크 문제라는 걸 알 수 있게 해줍니다.
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN 환경변수가 비어있어요. Render의 Environment 설정을 확인해주세요.');
} else {
  console.log('🔌 디스코드에 로그인을 시도합니다...');

  const loginWatchdog = setTimeout(() => {
    console.error(
      '⚠️ 로그인을 시도한 지 20초가 지났는데도 완료되지 않았어요. ' +
        'DISCORD_TOKEN 값이 잘못됐거나(디스코드 개발자 포털에서 토큰을 재발급했다면 Render 쪽 값도 바꿔야 함), ' +
        '네트워크 문제로 디스코드 게이트웨이에 연결하지 못하고 있을 가능성이 높아요.',
    );
  }, 20000);

  client
    .login(process.env.DISCORD_TOKEN)
    .then(() => clearTimeout(loginWatchdog))
    .catch((error) => {
      clearTimeout(loginWatchdog);
      console.error('❌ 로그인 실패:', error.stack || error);
    });
}
