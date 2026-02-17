const { Client, GatewayIntentBits } = require("discord.js");
const axios = require("axios");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const WEBHOOK_URL = process.env.WEBHOOK_URL;

client.once("clientReady", () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  // กรองกรณีที่ไม่ได้ย้ายห้อง (เช่น Mute/Deafen)
  if (oldState.channelId === newState.channelId) return;

  try {
    console.log(`User ${newState.id} changed voice state: ${oldState.channelId} -> ${newState.channelId}`);
    
    await axios.post(process.env.WEBHOOK_URL, {
      event: "VOICE_STATE_UPDATE",
      data: {
        user_id: newState.id,
        // ใช้ || null เพื่อกันเหนียว กรณี newState.channelId เป็น undefined จะได้ส่ง null ไปแน่นอน
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
