const { Client, GatewayIntentBits } = require("discord.js");
const axios = require("axios");
const http = require("http");
const crypto = require("crypto");

// 🌟 Health Check
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bear Cafe Voice Sensor is Active!");
}).listen(process.env.PORT || 8000);

const WEBHOOK_URL      = process.env.WEBHOOK_URL;
const VOICE_POINTS_URL = process.env.VOICE_POINTS_URL;
// เพิ่ม env นี้ใน Koyeb:
// VOICE_POINTS_URL = https://orbxyyjpvpbqwfssnyeq.supabase.co/functions/v1/voice-activity-points

// Track เวลาที่ user เข้าห้อง
const voiceJoinTimes = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// นับ user จริงในห้อง (ไม่นับบอท)
function getUserCountInChannel(guild, channelId) {
  if (!channelId) return 0;
  return guild.voiceStates.cache.filter(
    (vs) => vs.channelId === channelId && !vs.member?.user?.bot
  ).size;
}

// เรียก voice-activity-points function
async function awardVoicePoints(userId, durationSeconds, userCount) {
  if (!VOICE_POINTS_URL) return;
  const eventId = `voice-${userId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    const res = await axios.post(
      VOICE_POINTS_URL,
      { eventId, userId, duration: durationSeconds, userCount },
      { timeout: 10000 }
    );
    const d = res.data;
    if (d.skipped) {
      console.log(`[points] ${userId} skipped: ${d.reason}`);
    } else {
      console.log(`[points] ${userId} +${d.earned} pts → ${d.newPoints}/${d.maxCap}`);
    }
  } catch (err) {
    console.error(`[points] Error for ${userId}:`, err.response?.data ?? err.message);
  }
}

client.once("clientReady", async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  // Sync คนที่อยู่ในห้องอยู่แล้ว
  for (const guild of client.guilds.cache.values()) {
    for (const [memberId, voiceState] of guild.voiceStates.cache) {
      if (voiceState.channelId && !voiceState.member?.user?.bot) {
        // บันทึกเวลาเข้าห้อง
        voiceJoinTimes.set(memberId, {
          joinedAt: Date.now(),
          channelId: voiceState.channelId,
        });

        // ส่ง webhook เดิม
        try {
          await axios.post(WEBHOOK_URL, {
            event: "VOICE_STATE_UPDATE",
            data: {
              user_id: memberId,
              channel_id: voiceState.channelId,
              channel_name: voiceState.channel?.name ?? null,
              guild_id: guild.id
            }
          });
        } catch (err) {
          console.error(`[sync] Error for ${memberId}:`, err.message);
        }
      }
    }
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (oldState.channelId === newState.channelId) return;

  const userId = newState.id;
  const isBot  = newState.member?.user?.bot ?? false;

  // ── ออกจากห้อง ──────────────────────────────────────────────────────────
  if (oldState.channelId && !newState.channelId && !isBot) {
    const session = voiceJoinTimes.get(userId);
    if (session) {
      const durationSeconds = Math.floor((Date.now() - session.joinedAt) / 1000);
      const userCount = getUserCountInChannel(oldState.guild, oldState.channelId) + 1;
      console.log(`[voice] ${userId} left after ${durationSeconds}s (${userCount} users)`);
      awardVoicePoints(userId, durationSeconds, userCount); // fire-and-forget
    }
    voiceJoinTimes.delete(userId);
  }

  // ── เข้าห้อง ─────────────────────────────────────────────────────────────
  if (newState.channelId && !oldState.channelId && !isBot) {
    voiceJoinTimes.set(userId, {
      joinedAt: Date.now(),
      channelId: newState.channelId,
    });
  }

  // ── ย้ายห้อง ─────────────────────────────────────────────────────────────
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId && !isBot) {
    const session = voiceJoinTimes.get(userId);
    if (session) {
      const durationSeconds = Math.floor((Date.now() - session.joinedAt) / 1000);
      const userCount = getUserCountInChannel(oldState.guild, oldState.channelId) + 1;
      console.log(`[voice] ${userId} moved after ${durationSeconds}s`);
      awardVoicePoints(userId, durationSeconds, userCount);
    }
    voiceJoinTimes.set(userId, {
      joinedAt: Date.now(),
      channelId: newState.channelId,
    });
  }

  // ── ส่ง webhook เดิม (ไม่เปลี่ยน) ──────────────────────────────────────
  try {
    console.log(`User ${userId} changed: ${oldState.channelId} -> ${newState.channelId}`);
    await axios.post(WEBHOOK_URL, {
      event: "VOICE_STATE_UPDATE",
      data: {
        user_id: userId,
        channel_id: newState.channelId || null,
        channel_name: newState.channel?.name ?? null,
        guild_id: newState.guild.id
      }
    });
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

client.login(process.env.BOT_TOKEN);
