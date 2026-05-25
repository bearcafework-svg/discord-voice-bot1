require('dotenv').config(); // แม้ว่า Koyeb จะจัดการ Env ให้แล้ว แต่เผื่อไว้สำหรับการรัน Local
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { setupSecretChat } = require('./secretChat');
const { setupDonate }    = require('./donate');
const axios = require("axios");
const http = require("http");
const crypto = require("crypto");

// Health Check
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bear Cafe Voice Sensor is Active!");
}).listen(process.env.PORT || 8000);

const WEBHOOK_URL          = process.env.WEBHOOK_URL;
const VOICE_POINTS_URL     = process.env.VOICE_POINTS_URL;
const EXCLUDED_CATEGORY_ID = "1145057060686397611"; // ไม่นับแต้มห้องหมวดนี้

const voiceJoinTimes = new Map();

const client = new Client({
intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildPresences,
  GatewayIntentBits.DirectMessages
],
});

// เรียกใช้และเชื่อมต่อโมดูลระบบจับคู่เข้ากับ Client
setupSecretChat(client);

// เรียกใช้ระบบยอดโดเนท
setupDonate(client);

function getUserCountInChannel(guild, channelId) {
  if (!channelId) return 0;
  return guild.voiceStates.cache.filter(
    (vs) => vs.channelId === channelId &&!vs.member?.user?.bot
  ).size;
}

async function awardVoicePoints(userId, durationSeconds, userCount, channelName, parentId) {
  if (!VOICE_POINTS_URL) return;
  if (parentId === EXCLUDED_CATEGORY_ID) {
    console.log(`[points] ${userId} skipped — excluded category`);
    return;
  }
  const eventId = `voice-${userId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    const res = await axios.post(
      VOICE_POINTS_URL,
      { eventId, userId, duration: durationSeconds, userCount, channelName },
      { timeout: 10000 }
    );
    const d = res.data;
    if (d.skipped) {
      console.log(`[points] ${userId} skipped: ${d.reason}`);
    } else {
      console.log(`[points] ${userId} +${d.earned} pts → ${d.newPoints}/${d.maxCap}`);
    }
  } catch (err) {
    console.error(`[points] Error for ${userId}:`, err.response?.data?? err.message);
  }
}

// ตรวจสอบการเชื่อมต่อพื้นฐาน (เปลี่ยนไปใช้ Events.ClientReady ตามมาตรฐาน v14)
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[system] Logged in successfully as ${readyClient.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    for (const [memberId, voiceState] of guild.voiceStates.cache) {
      if (voiceState.channelId && !voiceState.member?.user?.bot) {
        voiceJoinTimes.set(memberId, {
          joinedAt: Date.now(),
          channelId: voiceState.channelId,
          channelName: voiceState.channel?.name?? null,
          parentId: voiceState.channel?.parentId?? null,
        });

        try {
          if (WEBHOOK_URL) {
            await axios.post(WEBHOOK_URL, {
              event: "VOICE_STATE_UPDATE",
              data: {
                user_id: memberId,
                channel_id: voiceState.channelId,
                channel_name: voiceState.channel?.name?? null,
                guild_id: guild.id
              }
            });
          }
        } catch (err) {
          console.error(`[sync] Error for ${memberId}:`, err.message);
        }
      }
    }
  }
});

// ── Voice count heartbeat ─────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

async function sendVoiceHeartbeat() {
  let total = 0;

  for (const guild of client.guilds.cache.values()) {
    for (const [memberId, voiceState] of guild.voiceStates.cache) {
      if (!voiceState.channelId || voiceState.member?.user?.bot) continue;

      try {
        if (WEBHOOK_URL) {
          await axios.post(WEBHOOK_URL, {
            event: "VOICE_STATE_UPDATE",
            data: {
              user_id: memberId,
              channel_id: voiceState.channelId,
              channel_name: voiceState.channel?.name?? null,
              guild_id: guild.id
            }
          });
        }
        total++;
      } catch (err) {
        console.error(`[heartbeat] Error for ${memberId}:`, err.message);
      }
    }
  }

  console.log(`[heartbeat] Refreshed ${total} voice state(s)`);
}

setInterval(() => {
  if (!client.isReady()) return;
  sendVoiceHeartbeat();
}, HEARTBEAT_INTERVAL_MS);

// จัดการเหตุการณ์ Voice State เปลี่ยนแปลง
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (oldState.channelId === newState.channelId) return;

  const userId = newState.id;
  const isBot  = newState.member?.user?.bot?? false;

  // ออกจากห้อง
  if (oldState.channelId &&!newState.channelId &&!isBot) {
    const session = voiceJoinTimes.get(userId);

    if (session) {
      const durationSeconds = Math.floor((Date.now() - session.joinedAt) / 1000);
      const userCount   = getUserCountInChannel(oldState.guild, oldState.channelId) + 1;
      const channelName = oldState.channel?.name?? "ห้องพูดคุย";
      const parentId    = oldState.channel?.parentId?? null;

      console.log(`[voice] ${userId} left after ${durationSeconds}s (cat: ${parentId})`);
      awardVoicePoints(userId, durationSeconds, userCount, channelName, parentId);
    }
    voiceJoinTimes.delete(userId);
  }

  // เข้าห้อง
  if (newState.channelId &&!oldState.channelId &&!isBot) {
    voiceJoinTimes.set(userId, {
      joinedAt: Date.now(),
      channelId: newState.channelId,
      channelName: newState.channel?.name?? null,
      parentId: newState.channel?.parentId?? null,
    });
  }

  // ย้ายห้อง
  if (
    oldState.channelId &&
    newState.channelId &&
    oldState.channelId!== newState.channelId &&
   !isBot
  ) {
    const session = voiceJoinTimes.get(userId);

    if (session) {
      const durationSeconds = Math.floor((Date.now() - session.joinedAt) / 1000);
      const userCount   = getUserCountInChannel(oldState.guild, oldState.channelId) + 1;
      const channelName = oldState.channel?.name?? "ห้องพูดคุย";
      const parentId    = oldState.channel?.parentId?? null;

      console.log(`[voice] ${userId} moved after ${durationSeconds}s (cat: ${parentId})`);
      awardVoicePoints(userId, durationSeconds, userCount, channelName, parentId);
    }

    voiceJoinTimes.set(userId, {
      joinedAt: Date.now(),
      channelId: newState.channelId,
      channelName: newState.channel?.name?? null,
      parentId: newState.channel?.parentId?? null,
    });
  }

  // Webhook เดิม
  try {
    if (WEBHOOK_URL) {
      console.log(`User ${userId} changed: ${oldState.channelId} -> ${newState.channelId}`);
      await axios.post(WEBHOOK_URL, {
        event: "VOICE_STATE_UPDATE",
        data: {
          user_id: userId,
          channel_id: newState.channelId || null,
          channel_name: newState.channel?.name?? null,
          guild_id: newState.guild.id
        }
      });
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// สร้างข่ายนิรภัยระดับแอปพลิเคชันป้องกันการล่มจาก Promise ที่ถูกปฏิเสธโดยไม่มีคนดักจับ
process.on("unhandledRejection", (error) => {
  console.error("[system] Unhandled Promise Rejection:", error);
});

// เริ่มการเชื่อมต่อผ่านโทเคน
client.login(process.env.BOT_TOKEN);
