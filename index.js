require('dotenv').config();

const http = require('http');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
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

const YTDLP_PATH = path.join(__dirname, 'bin', 'yt-dlp');

// 검색어 또는 유튜브 링크를 넣으면 { title, url }을 반환합니다.
// url은 실제 오디오(webm/opus) 파일을 가리키는 다이렉트 링크입니다.
function getAudioInfo(query) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_PATH,
      [
        '--no-warnings',
        '--no-playlist',
        '--dump-single-json',
        '--format',
        'bestaudio[ext=webm]/bestaudio',
        '--default-search',
        'ytsearch1',
        query,
      ],
      { maxBuffer: 1024 * 1024 * 20, timeout: 30_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const info = JSON.parse(stdout);
          resolve({ title: info.title, url: info.url });
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

// 다이렉트 오디오 URL을 읽을 수 있는 스트림으로 반환합니다 (리다이렉트 자동 처리).
function fetchAudioStream(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('리다이렉트가 너무 많습니다'));
      return;
    }
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          resolve(fetchAudioStream(res.headers.location, redirectCount + 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`오디오 스트림 요청 실패 (HTTP ${res.statusCode})`));
          return;
        }
        resolve(res);
      })
      .on('error', reject);
  });
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
  ],
});

// 길드(서버)별 목소리/속도 설정을 저장합니다.
// 주의: 메모리에만 저장되므로 봇이 재시작되면 기본값으로 초기화됩니다.
const guildSettings = new Map();

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
    .setName('재생')
    .setDescription('노래를 재생하거나 대기열에 추가합니다')
    .addStringOption((option) =>
      option
        .setName('검색어')
        .setDescription('노래 제목 또는 유튜브 링크')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('스킵')
    .setDescription('지금 재생 중인 노래를 건너뜁니다'),
  new SlashCommandBuilder()
    .setName('정지')
    .setDescription('재생을 멈추고 대기열을 비웁니다'),
  new SlashCommandBuilder()
    .setName('일시정지')
    .setDescription('재생을 일시정지합니다'),
  new SlashCommandBuilder()
    .setName('재개')
    .setDescription('일시정지된 재생을 다시 시작합니다'),
  new SlashCommandBuilder()
    .setName('대기열')
    .setDescription('현재 대기열을 보여줍니다'),
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

// 길드(서버)별로 오디오 플레이어와 대기열을 관리합니다.
// queue의 각 항목: { type: 'tts', text } 또는 { type: 'music', title, url }
const guildAudio = new Map();

function getGuildAudio(guildId) {
  if (!guildAudio.has(guildId)) {
    const player = createAudioPlayer();
    const state = { player, queue: [], playing: false, nowPlaying: null };
    guildAudio.set(guildId, state);

    // 재생이 끝나면 대기열의 다음 항목을 재생하고,
    // 더 이상 재생할 게 없으면 잠시 후 채널을 나갑니다.
    player.on(AudioPlayerStatus.Idle, () => {
      state.playing = false;
      state.nowPlaying = null;
      if (state.queue.length > 0) {
        playNext(guildId);
      } else {
        scheduleLeave(guildId);
      }
    });

    player.on('error', (error) => {
      console.error(`[오디오 재생 오류] 길드 ${guildId}:`, error.message);
      state.playing = false;
      state.nowPlaying = null;
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

  const item = state.queue.shift();
  state.playing = true;

  try {
    if (item.type === 'tts') {
      const settings = getSettings(guildId);
      const tts = new MsEdgeTTS();
      await tts.setMetadata(settings.voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
      const { audioStream } = tts.toStream(item.text, { rate: rateToString(settings.rate) });
      const resource = createAudioResource(audioStream, { inputType: StreamType.WebmOpus });
      state.nowPlaying = null;
      state.player.play(resource);
    } else if (item.type === 'music') {
      const audioStream = await fetchAudioStream(item.url);
      const resource = createAudioResource(audioStream, { inputType: StreamType.WebmOpus });
      state.nowPlaying = item;
      state.player.play(resource);
    }
  } catch (error) {
    console.error('재생 오류:', error.message);
    state.playing = false;
    state.nowPlaying = null;
    playNext(guildId);
  }
}

// voiceChannel: 접속할 음성채널, item: 큐에 넣을 항목({type, ...})
async function enqueue(voiceChannel, item) {
  const guildId = voiceChannel.guild.id;

  // 나가려고 예약해둔 게 있다면 취소합니다 (새로 재생할 게 생겼으므로).
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
      return false;
    }

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      cancelScheduledLeave(guildId);
    });
  }

  const state = getGuildAudio(guildId);
  connection.subscribe(state.player);
  state.queue.push(item);
  playNext(guildId);
  return true;
}

async function speak(voiceChannel, text) {
  await enqueue(voiceChannel, { type: 'tts', text });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ 로그인 완료: ${c.user.tag}`);

  // 봇이 들어가 있는 모든 서버에 슬래시 명령어를 등록합니다.
  for (const guild of c.guilds.cache.values()) {
    await registerCommandsForGuild(guild.id);
  }
  console.log('✅ 슬래시 명령어 등록 완료');
});

// 봇이 새로운 서버에 초대되면 그 서버에도 명령어를 등록합니다.
client.on(Events.GuildCreate, (guild) => {
  registerCommandsForGuild(guild.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
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

  // ===== 음악 명령어 (누구나 사용 가능) =====
  if (interaction.commandName === '재생') {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: '먼저 음성채널에 들어가 있어야 해요.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const query = interaction.options.getString('검색어');
    try {
      const { title, url } = await getAudioInfo(query);

      const state = getGuildAudio(guildId);
      const wasIdle = state.queue.length === 0 && !state.playing;
      await enqueue(voiceChannel, { type: 'music', title, url });

      await interaction.editReply(
        wasIdle ? `🎵 지금 재생: **${title}**` : `➕ 대기열에 추가됨: **${title}**`,
      );
    } catch (error) {
      console.error('재생 명령어 오류:', error.message);
      await interaction.editReply('노래를 재생하는 중 오류가 발생했어요. 다른 검색어나 링크로 시도해보세요.');
    }
    return;
  }

  if (interaction.commandName === '스킵') {
    const state = guildAudio.get(guildId);
    if (!state || !state.playing) {
      await interaction.reply({ content: '지금 재생 중인 게 없어요.', ephemeral: true });
      return;
    }
    state.player.stop(); // Idle 이벤트가 발생해서 자동으로 다음 곡으로 넘어갑니다.
    await interaction.reply('⏭️ 다음 곡으로 넘어갈게요.');
    return;
  }

  if (interaction.commandName === '정지') {
    const state = guildAudio.get(guildId);
    if (state) {
      state.queue = [];
      state.player.stop();
    }
    const connection = getVoiceConnection(guildId);
    if (connection) connection.destroy();
    await interaction.reply('⏹️ 재생을 멈추고 채널에서 나갔어요.');
    return;
  }

  if (interaction.commandName === '일시정지') {
    const state = guildAudio.get(guildId);
    if (!state || !state.playing) {
      await interaction.reply({ content: '지금 재생 중인 게 없어요.', ephemeral: true });
      return;
    }
    state.player.pause();
    await interaction.reply('⏸️ 일시정지했어요.');
    return;
  }

  if (interaction.commandName === '재개') {
    const state = guildAudio.get(guildId);
    if (!state) {
      await interaction.reply({ content: '지금 재생 중인 게 없어요.', ephemeral: true });
      return;
    }
    state.player.unpause();
    await interaction.reply('▶️ 다시 재생할게요.');
    return;
  }

  if (interaction.commandName === '대기열') {
    const state = guildAudio.get(guildId);
    if (!state || (!state.nowPlaying && state.queue.length === 0)) {
      await interaction.reply({ content: '대기열이 비어있어요.', ephemeral: true });
      return;
    }
    const lines = [];
    if (state.nowPlaying) lines.push(`🎵 지금 재생 중: **${state.nowPlaying.title}**`);
    const musicQueue = state.queue.filter((item) => item.type === 'music');
    musicQueue.slice(0, 10).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.title}`);
    });
    if (musicQueue.length > 10) lines.push(`...외 ${musicQueue.length - 10}곡`);
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
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

client.login(process.env.DISCORD_TOKEN);
