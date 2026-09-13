require('dotenv').config();

const http = require('http');
const { Client, GatewayIntentBits, Events } = require('discord.js');
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

// ===== 음성 설정 (여기 값만 바꾸면 목소리/속도가 바뀝니다) =====
const TTS_VOICE = 'ko-KR-InJoonNeural'; // 남자 목소리. 여자 목소리는 'ko-KR-SunHiNeural'
const TTS_RATE = '+25%'; // 말하기 속도. 기본은 '+0%', 더 빠르게는 '+40%', '+60%' 등으로 조절
// ============================================================

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

// 길드(서버)별로 오디오 플레이어와 대기열을 관리합니다.
// { player, queue: string[], playing: boolean }
const guildAudio = new Map();

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

function getGuildAudio(guildId) {
  if (!guildAudio.has(guildId)) {
    const player = createAudioPlayer();
    const state = { player, queue: [], playing: false };
    guildAudio.set(guildId, state);

    // 재생이 끝나면 대기열의 다음 문장을 재생하고,
    // 더 이상 재생할 게 없으면 잠시 후 채널을 나갑니다.
    player.on(AudioPlayerStatus.Idle, () => {
      state.playing = false;
      if (state.queue.length > 0) {
        playNext(guildId);
      } else {
        scheduleLeave(guildId);
      }
    });

    player.on('error', (error) => {
      console.error(`[오디오 재생 오류] 길드 ${guildId}:`, error.message);
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

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(TTS_VOICE, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    const { audioStream } = tts.toStream(text, { rate: TTS_RATE });

    const resource = createAudioResource(audioStream, { inputType: StreamType.WebmOpus });
    state.player.play(resource);
  } catch (error) {
    console.error('TTS 생성 오류:', error.message);
    state.playing = false;
    playNext(guildId);
  }
}

async function speak(voiceChannel, text) {
  const guildId = voiceChannel.guild.id;

  // 나가려고 예약해둔 게 있다면 취소합니다 (새로 알릴 게 생겼으므로).
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

client.once(Events.ClientReady, (c) => {
  console.log(`✅ 로그인 완료: ${c.user.tag}`);
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

// 진단용: 토큰이 실제로 전달되는지 확인 (토큰 내용 자체는 출력하지 않습니다)
const tokenCheck = process.env.DISCORD_TOKEN;
if (!tokenCheck) {
  console.log('❌ DISCORD_TOKEN 환경변수를 찾을 수 없습니다 (undefined 또는 빈 값).');
} else {
  console.log(`✅ DISCORD_TOKEN 확인됨 (길이: ${tokenCheck.length}자)`);
}

client.login(process.env.DISCORD_TOKEN);
