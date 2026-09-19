require('dotenv').config();

// 외부 라이브러리에서 예기치 못한 오류가 나도
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
  EmbedBuilder,
  AttachmentBuilder,
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

// 채널별로 가장 최근에 만든 투표 메시지 ID를 기억합니다 (/투표종료에서 사용).
const activePolls = new Map();

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

// 한국어가 섞인 프롬프트를 영어로 번역합니다 (이미지 생성 모델이 영어를 훨씬 잘 이해하기 때문).
// 무료 번역 API(MyMemory)를 사용하며, 실패하면 원문을 그대로 반환합니다.
async function translateToEnglishIfKorean(text) {
  const hasKorean = /[\u3131-\uD79D]/.test(text);
  if (!hasKorean) return text;

  try {
    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=ko|en`,
    );
    const data = await response.json();
    const translated = data && data.responseData && data.responseData.translatedText;
    return translated || text;
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
      const response = await fetch(imageUrl);
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
      console.error('이미지 생성 오류:', error.message);
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
