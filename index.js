require('dotenv').config();

// 라바링크 같은 외부 라이브러리에서 예기치 못한 오류가 나도
// 봇 전체(입퇴장 안내 포함)가 죽지 않도록 안전장치를 겁니다.
process.on('uncaughtException', (error) => {
  console.error('⚠️ 처리되지 않은 예외 발생 (봇은 계속 실행됩니다):', error.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ 처리되지 않은 Promise 거부 발생 (봇은 계속 실행됩니다):', reason);
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
const { LavalinkManager } = require('lavalink-client');

// ===== 기본 음성 설정 (/목소리, /속도 명령어로 서버별로 바꿀 수 있습니다) =====
const DEFAULT_VOICE = 'ko-KR-InJoonNeural'; // 남자 목소리. 여자 목소리는 'ko-KR-SunHiNeural'
const DEFAULT_RATE = 25; // 기본 속도(%). 0이 보통 속도, 25면 25% 빠르게
// ======================================================================

// ===== 노래 재생용 Lavalink 노드 =====
// 환경변수로 직접 지정하지 않으면 공개 무료 노드를 기본값으로 사용합니다.
// 공개 노드는 언제든 죽을 수 있어서, 안 되면 다른 노드로 바꿔야 할 수 있습니다 (README 참고).
const LAVALINK_NODES = [
  {
    id: 'main',
    host: process.env.LAVALINK_HOST || 'lava-v4.ajieblogs.eu.org',
    port: Number(process.env.LAVALINK_PORT) || 443,
    authorization: process.env.LAVALINK_PASSWORD || 'https://dsc.gg/ajidevserver',
    secure: process.env.LAVALINK_SECURE ? process.env.LAVALINK_SECURE === 'true' : true,
  },
];
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

// ===== 입퇴장 안내(TTS) 재생 큐 =====
// 노래 재생은 Lavalink가 완전히 별도로 처리하므로, 여기는 TTS 안내만 다룹니다.
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

  // 노래가 재생 중이면 음성 연결이 충돌하지 않도록 안내를 건너뜁니다.
  const musicPlayer = client.lavalink && client.lavalink.getPlayer(guildId);
  if (musicPlayer && (musicPlayer.playing || musicPlayer.paused)) {
    return;
  }

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

  // ===== Lavalink 초기화 (노래 재생 담당) =====
  client.lavalink = new LavalinkManager({
    nodes: LAVALINK_NODES,
    sendToShard: (guildId, payload) => {
      const guild = client.guilds.cache.get(guildId);
      if (guild) guild.shard.send(payload);
    },
    autoSkip: true,
    client: { id: c.user.id, username: c.user.username },
  });

  client.lavalink.nodeManager.on('connect', (node) => {
    console.log(`✅ Lavalink 노드 연결됨: ${node.id}`);
  });
  client.lavalink.nodeManager.on('error', (node, error) => {
    console.error(`⚠️ Lavalink 노드 연결 오류 (${node.id}):`, error.message);
  });

  try {
    await client.lavalink.init({ id: c.user.id, username: c.user.username });
  } catch (error) {
    console.error('⚠️ Lavalink 초기화 실패 (음악 기능만 안 될 수 있음):', error.message);
  }

  // 봇이 들어가 있는 모든 서버에 슬래시 명령어를 등록합니다.
  for (const guild of c.guilds.cache.values()) {
    await registerCommandsForGuild(guild.id);
  }
  console.log('✅ 슬래시 명령어 등록 완료');
});

// Lavalink가 음성 서버 정보를 받을 수 있도록 원본 게이트웨이 이벤트를 전달합니다.
client.on('raw', (data) => {
  if (client.lavalink) client.lavalink.sendRawData(data);
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

  // ===== 음악 명령어 (누구나 사용 가능, Lavalink로 처리) =====
  if (interaction.commandName === '재생') {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: '먼저 음성채널에 들어가 있어야 해요.', ephemeral: true });
      return;
    }
    if (!client.lavalink) {
      await interaction.reply({ content: '음악 시스템이 아직 준비 중이에요. 잠시 후 다시 시도해주세요.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      let player = client.lavalink.getPlayer(guildId);
      if (!player) {
        player = client.lavalink.createPlayer({
          guildId,
          voiceChannelId: voiceChannel.id,
          textChannelId: interaction.channelId,
          selfDeaf: true,
        });
      }
      if (!player.connected) {
        await player.connect();
      }

      const query = interaction.options.getString('검색어');
      const result = await player.search({ query, source: 'ytsearch' }, interaction.user);

      if (!result || !result.tracks.length) {
        await interaction.editReply('검색 결과를 찾을 수 없어요.');
        return;
      }

      const wasIdle = !player.playing && !player.paused && player.queue.tracks.length === 0;

      if (result.loadType === 'playlist') {
        await player.queue.add(result.tracks);
      } else {
        await player.queue.add(result.tracks[0]);
      }

      if (!player.playing && !player.paused) {
        await player.play();
      }

      const title = result.tracks[0].info.title;
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
    const player = client.lavalink && client.lavalink.getPlayer(guildId);
    if (!player || !player.playing) {
      await interaction.reply({ content: '지금 재생 중인 게 없어요.', ephemeral: true });
      return;
    }
    await player.skip();
    await interaction.reply('⏭️ 다음 곡으로 넘어갈게요.');
    return;
  }

  if (interaction.commandName === '정지') {
    const player = client.lavalink && client.lavalink.getPlayer(guildId);
    if (player) await player.destroy();
    await interaction.reply('⏹️ 재생을 멈추고 채널에서 나갔어요.');
    return;
  }

  if (interaction.commandName === '일시정지') {
    const player = client.lavalink && client.lavalink.getPlayer(guildId);
    if (!player || !player.playing) {
      await interaction.reply({ content: '지금 재생 중인 게 없어요.', ephemeral: true });
      return;
    }
    await player.pause();
    await interaction.reply('⏸️ 일시정지했어요.');
    return;
  }

  if (interaction.commandName === '재개') {
    const player = client.lavalink && client.lavalink.getPlayer(guildId);
    if (!player) {
      await interaction.reply({ content: '지금 재생 중인 게 없어요.', ephemeral: true });
      return;
    }
    await player.resume();
    await interaction.reply('▶️ 다시 재생할게요.');
    return;
  }

  if (interaction.commandName === '대기열') {
    const player = client.lavalink && client.lavalink.getPlayer(guildId);
    if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
      await interaction.reply({ content: '대기열이 비어있어요.', ephemeral: true });
      return;
    }
    const lines = [];
    if (player.queue.current) lines.push(`🎵 지금 재생 중: **${player.queue.current.info.title}**`);
    player.queue.tracks.slice(0, 10).forEach((track, i) => {
      lines.push(`${i + 1}. ${track.info.title}`);
    });
    if (player.queue.tracks.length > 10) lines.push(`...외 ${player.queue.tracks.length - 10}곡`);
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
