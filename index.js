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

client.once("voiceStateUpdate", async (oldState, newState) => {
  try {
    await axios.post(WEBHOOK_URL, {
      event: "VOICE_STATE_UPDATE",
      data: {
        user_id: newState.id,
        channel_id: newState.channelId,
        channel_name: newState.channel?.name ?? null,
        guild_id: newState.guild.id
      }
    });
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

client.login(process.env.BOT_TOKEN);


