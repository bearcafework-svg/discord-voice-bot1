const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  Events
} = require("discord.js");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const http = require("http"); // สำหรับ Koyeb Health Check

// ============================================================================
// SYSTEM CONFIGURATION & CONSTANTS
// ============================================================================
const SECRET_CHAT_CATEGORY_ID = process.env.SECRET_CHAT_CATEGORY_ID;

const BLOCKED_ROLES = ["1156930837573546126", "1156930842434752614"];
const SESSION_DURATION_MS = 7 * 60 * 1000;   // 7 นาที
const WARNING_1MIN_MS     = 6 * 60 * 1000;   // แจ้งเตือนที่ 6 นาที (เหลือ 1 นาที)
const WARNING_30SEC_MS    = 6.5 * 60 * 1000; // แจ้งเตือนที่ 6:30 นาที (เหลือ 30 วินาที)

const JOIN_QUEUE_CUSTOM_ID  = "btn_join_queue";
const LEAVE_TABLE_CUSTOM_ID = "btn_leave_table";
const REPORT_USER_CUSTOM_ID = "btn_report_user";


// ============================================================================
// LOGGING HELPER
// ============================================================================
async function logEvent(event, data = {}) {
  try {
    const { error } = await supabase.from("secret_chat_logs").insert([{
      event,
      channel_id: data.channelId ?? null,
      user_id:    data.userId    ?? null,
      partner_id: data.partnerId ?? null,
      staff_id:   data.staffId   ?? null,
      guild_id:   data.guildId   ?? null,
      metadata:   data.metadata  ?? {},
    }]);
    if (error) console.error("[secret-chat] logEvent error:", error.message);
  } catch (err) {
    console.error("[secret-chat] logEvent exception:", err.message);
  }
}

// ============================================================================
// IN-MEMORY STATE MANAGEMENT
// ============================================================================
const queue         = [];
const activeUsers   = new Set();
const tableMembers  = new Map();
const sessionTimers = new Map();
const recentMatches = new Map();
const spamTracker   = new Map();

// ============================================================================
// SUPABASE INITIALIZATION
// ============================================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: { transport: ws },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);

// ============================================================================
// GLOBAL ERROR HANDLING
// ============================================================================
process.on("unhandledRejection", (error) => {
  console.error("[secret-chat] Unhandled rejection:", error);
});
process.on("uncaughtException", (error) => {
  console.error("[secret-chat] Uncaught exception:", error);
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function buildAllowedPermissions() {
  return [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];
}

function buildActionRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(LEAVE_TABLE_CUSTOM_ID)
      .setLabel("🚪 ลุกจากโต๊ะ")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(REPORT_USER_CUSTOM_ID)
      .setLabel("⚠️ แจ้งรีพอร์ต")
      .setStyle(ButtonStyle.Secondary)
  );
}

function clearSessionTimers(channelId) {
  const timers = sessionTimers.get(channelId);
  if (timers) {
    clearTimeout(timers.warning1m);
    clearTimeout(timers.warning30s);
    clearTimeout(timers.termination);
    sessionTimers.delete(channelId);
    console.log(`[secret-chat] Timers cleared for channel: ${channelId}`);
  }
}

function isUserBusy(userId) {
  return activeUsers.has(userId) || queue.includes(userId);
}

function checkSpamRateLimit(userId) {
  const now = Date.now();
  const timestamps = spamTracker.get(userId) || [];
  const recent = timestamps.filter((t) => now - t < 60000);
  recent.push(now);
  spamTracker.set(userId, recent);
  return recent.length > 3;
}

// ============================================================================
// [FIX] SESSION CLEANUP: แยกออกมาเป็น function เดียว ชัดเจน ไม่ซ้อน try-catch
// ============================================================================
async function cleanupSession(channelId, userAId, userBId, channel) {
  console.log(`[secret-chat] cleanupSession called for channel: ${channelId}`);

  // ล้าง state ก่อนเสมอ แม้ channel.delete จะพัง
  tableMembers.delete(channelId);
  sessionStartTimes.delete(channelId);
  activeUsers.delete(userAId);
  activeUsers.delete(userBId);

  if (!channel) {
    console.warn(`[secret-chat] cleanupSession: channel object is null, skipping delete`);
    return;
  }

  // คำนวณ duration จาก session_start log
  const durationMs = Date.now() - (sessionStartTimes.get(channelId) ?? Date.now());
  await logEvent("session_end", {
    channelId,
    userId:   userAId,
    partnerId: userBId,
    metadata: { duration_seconds: Math.round(durationMs / 1000), ended_by: "timeout" },
  });

  try {
    await channel.delete("Session timeout reached");
    console.log(`[secret-chat] Channel ${channelId} deleted successfully`);
  } catch (deleteError) {
    // ห้องอาจถูกลบไปแล้ว (แอดมินลบ / ลุกจากโต๊ะ) ไม่ใช่ error ร้ายแรง
    console.warn(`[secret-chat] Channel delete warning (may already be deleted): ${deleteError.message}`);
  }
}

// ============================================================================
// ORPHAN RECOVERY ON STARTUP
// ============================================================================
async function runCrashRecovery(client) {
  if (!SECRET_CHAT_CATEGORY_ID) return;
  try {
    console.log("[secret-chat] Initiating orphan channel recovery...");
    for (const guild of client.guilds.cache.values()) {
      const category = guild.channels.cache.get(SECRET_CHAT_CATEGORY_ID);
      if (!category) continue;

      const orphanedChannels = category.children.cache.filter(
        (ch) => ch.name.includes("☕-โต๊ะลับ-")
      );

      for (const [, ch] of orphanedChannels) {
        await ch.delete("Automated cleanup of orphaned channel post-restart");
        console.log(`[secret-chat] Purged orphaned channel: ${ch.name}`);
      }
    }
  } catch (error) {
    console.error("[secret-chat] Recovery sequence failed:", error);
  }
}

// ============================================================================
// CORE LOGIC: CHANNEL PROVISIONING
// ============================================================================
async function createSecretChatChannel(guild, userAId, userBId) {
  const category = guild.channels.cache.get(SECRET_CHAT_CATEGORY_ID);
  if (!category) throw new Error("SECRET_CHAT_CATEGORY_NOT_FOUND");

  const suffix = crypto.randomBytes(2).toString("hex");
  const channel = await guild.channels.create({
    name: `☕-โต๊ะลับ-${suffix}`,
    type: ChannelType.GuildText,
    parent: SECRET_CHAT_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: userAId, allow: buildAllowedPermissions() },
      { id: userBId, allow: buildAllowedPermissions() }
    ]
  });

  activeUsers.add(userAId);
  activeUsers.add(userBId);
  tableMembers.set(channel.id, new Set([userAId, userBId]));

  recentMatches.set(`${userAId}-${userBId}`, Date.now());
  recentMatches.set(`${userBId}-${userAId}`, Date.now());

  const endTime = Math.floor((Date.now() + SESSION_DURATION_MS) / 1000);

  await channel.send({
    content: `☕ โต๊ะลับพร้อมแล้วค่ะ\n\nยินดีต้อนรับ <@${userAId}> และ <@${userBId}> ✨\nระยะเวลาสนทนา 7 นาที (หมดเวลา: <t:${endTime}:R>)\nสามารถพูดคุยกันได้ตามสบายเลยนะคะ`,
    components: [buildActionRow()]
  });

  // [FIX] ใช้ channel.id เก็บไว้ก่อน ป้องกัน reference ค้าง
  const channelId = channel.id;

  const timerData = {
    // [FIX] Warning 1 นาที
    warning1m: setTimeout(async () => {
      console.log(`[secret-chat] Firing 1min warning for channel: ${channelId}`);
      try {
        // เช็คก่อนว่าห้องยังอยู่ใน state (ไม่ถูกปิดไปก่อน)
        if (!tableMembers.has(channelId)) {
          console.log(`[secret-chat] 1min warning skipped: channel already closed`);
          return;
        }
        await channel.send("⏳ **เหลือเวลาอีก 1 นาที** โต๊ะจะปิดอัตโนมัติค่ะ");
      } catch (e) {
        console.error(`[secret-chat] 1min warning error:`, e.message);
      }
    }, WARNING_1MIN_MS),

    // [FIX] Warning 30 วินาที
    warning30s: setTimeout(async () => {
      console.log(`[secret-chat] Firing 30s warning for channel: ${channelId}`);
      try {
        if (!tableMembers.has(channelId)) {
          console.log(`[secret-chat] 30s warning skipped: channel already closed`);
          return;
        }
        await channel.send("⚠️ **เหลือเวลาอีก 30 วินาที** เตรียมบอกลากันได้เลยนะคะ!");
      } catch (e) {
        console.error(`[secret-chat] 30s warning error:`, e.message);
      }
    }, WARNING_30SEC_MS),

    // [FIX] Termination — ไม่เรียก clearSessionTimers ตัวเอง ใช้ cleanupSession แทน
    termination: setTimeout(async () => {
      console.log(`[secret-chat] Termination timer fired for channel: ${channelId}`);
      try {
        if (tableMembers.has(channelId)) {
          await channel.send("🛑 หมดเวลาสนทนาแล้วค่ะ กำลังทำความสะอาดโต๊ะ...");
        }
      } catch (e) {
        console.error(`[secret-chat] Termination send error:`, e.message);
      }
      // ลบ timer entry ก่อน แล้วค่อย cleanup
      sessionTimers.delete(channelId);
      await cleanupSession(channelId, userAId, userBId, channel);
    }, SESSION_DURATION_MS)
  };

  sessionTimers.set(channelId, timerData);
  sessionStartTimes.set(channelId, Date.now());
  console.log(`[secret-chat] Created room ${channel.name} for ${userAId} + ${userBId}`);
  return channel;
}

// ============================================================================
// INTERACTION HANDLERS
// ============================================================================
async function handleJoinQueue(interaction) {
  const userId = interaction.user.id;

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (error) {
    if (error.code === 10062) return;
    return;
  }

  // ตรวจสอบ Role ที่ถูกบล็อก
  if (interaction.member?.roles) {
    const hasBlockedRole = BLOCKED_ROLES.some((roleId) =>
      interaction.member.roles.cache.has(roleId)
    );
    if (hasBlockedRole) {
      return await interaction.editReply("ขออภัยค่ะ สิทธิ์ของคุณไม่สามารถใช้งานโต๊ะลับได้ในขณะนี้ ☕");
    }
  }

  // ตรวจสอบ state ซ้ำ และ spam
  if (isUserBusy(userId)) {
    return await interaction.editReply("ตอนนี้คุณอยู่ในคิวหรือกำลังนั่งโต๊ะอยู่แล้วนะคะ ☕");
  }
  if (checkSpamRateLimit(userId)) {
    return await interaction.editReply("คุณทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่ค่ะ ⏳");
  }

  // ค้นหาคู่สนทนา
  const partnerIndex = queue.findIndex((id) => {
    if (id === userId) return false;
    const lastMatchTime = recentMatches.get(`${userId}-${id}`);
    if (lastMatchTime && Date.now() - lastMatchTime < 300000) return false;
    return true;
  });

  if (partnerIndex !== -1) {
    const [waitingUserId] = queue.splice(partnerIndex, 1);
    try {
      await createSecretChatChannel(interaction.guild, waitingUserId, userId);
      await interaction.editReply("จับคู่สำเร็จแล้วค่ะ ✨ ขอให้สนุกนะคะ");
    } catch (error) {
      console.error("[secret-chat] create room error:", error);
      activeUsers.delete(waitingUserId);
      activeUsers.delete(userId);
      await interaction.editReply("เกิดปัญหาระหว่างสร้างโต๊ะลับค่ะ ลองใหม่อีกครั้งนะคะ");
    }
  } else {
    queue.push(userId);
    console.log(`[secret-chat] ${userId} joined queue. Total waiting: ${queue.length}`);
    await interaction.editReply("☕ เข้าคิวเรียบร้อยแล้วค่ะ\n\nระบบจะจับคู่ให้อัตโนมัติเมื่อมีคนเข้ามาเพิ่ม ✨");
  }
}

async function handleLeaveTable(interaction) {
  const channelId = interaction.channelId;
  const members = tableMembers.get(channelId);

  if (!members || !members.has(interaction.user.id)) {
    return await interaction.reply({
      content: "ปุ่มนี้ใช้ได้เฉพาะคนที่อยู่โต๊ะนี้ค่ะ",
      ephemeral: true
    });
  }

  try {
    await interaction.deferUpdate();

    // ล้าง timer ก่อน แล้วค่อย cleanup
    clearSessionTimers(channelId);

    const membersCopy = new Set(members); // copy ก่อน delete
    tableMembers.delete(channelId);
    for (const memberId of membersCopy) {
      activeUsers.delete(memberId);
    }

    console.log(`[secret-chat] Channel ${channelId} closed by ${interaction.user.id}`);
    await interaction.channel.delete(`Secret chat closed by ${interaction.user.id}`);
  } catch (error) {
    console.error("[secret-chat] Leave error:", error);
  }
}

// ติดตามเคสที่ถูกรับแล้ว (channelId -> staffId)
const claimedReports = new Map();
const sessionStartTimes = new Map(); // channelId -> timestamp (ms)

const CLAIM_CASE_CUSTOM_ID = "btn_claim_case";
const STAFF_ALERT_CHANNEL_ID = "1145314688800927744";

async function handleReportUser(interaction) {
  const channelId = interaction.channelId;
  const reporterId = interaction.user.id;
  const members = tableMembers.get(channelId);

  if (!members || !members.has(reporterId)) {
    return await interaction.reply({ content: "ไม่สามารถดำเนินการได้", ephemeral: true });
  }

  // แจ้งผู้ใช้ว่ากำลังติดต่อทีมงาน
  try {
    await interaction.reply({
      content: "⚠️ กำลังติดต่อทีมงาน รอสักครู่นะคะ...",
      ephemeral: true,
    });
  } catch (e) { return; }

  try {
    const staffChannel = await interaction.client.channels.fetch(STAFF_ALERT_CHANNEL_ID);
    if (!staffChannel) return;

    const alertEmbed = new EmbedBuilder()
      .setColor("#FF4444")
      .setTitle("🚨 พบการแจ้งปัญหาที่โซนสุ่มแชทคุย")
      .addFields(
        { name: "ห้องแชท", value: `<#${channelId}>`, inline: true },
        { name: "ผู้แจ้ง", value: `<@${reporterId}>`, inline: true },
        { name: "สถานะ", value: "⏳ รอทีมงานรับเคส", inline: true }
      )
      .setTimestamp();

    const claimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CLAIM_CASE_CUSTOM_ID}:${channelId}`)
        .setLabel("✅ รับเคส")
        .setStyle(ButtonStyle.Danger)
    );

    await staffChannel.send({
      content: `<@&${STAFF_ALERT_CHANNEL_ID}>  พบการแจ้งปัญหาที่โซนสุ่มแชทคุย`,
      embeds: [alertEmbed],
      components: [claimRow],
    });

    await logEvent("report_sent", {
      channelId: channelId,
      userId:    reporterId,
      guildId:   interaction.guildId,
    });

  } catch (err) {
    console.error("[secret-chat] handleReportUser error:", err);
  }
}

async function handleClaimCase(interaction) {
  // ดึง channelId จาก customId เช่น "btn_claim_case:123456789"
  const channelId = interaction.customId.split(":")[1];
  const staffId = interaction.user.id;

  // ตรวจสอบว่าถูกรับไปแล้วหรือยัง
  if (claimedReports.has(channelId)) {
    const existingStaff = claimedReports.get(channelId);
    return await interaction.reply({
      content: `เคสนี้ถูกรับโดย <@${existingStaff}> แล้วค่ะ`,
      ephemeral: true,
    });
  }

  claimedReports.set(channelId, staffId);

  // อัปเดตปุ่มให้กดไม่ได้ + แสดงชื่อคนรับ
  const disabledRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CLAIM_CASE_CUSTOM_ID}:${channelId}`)
      .setLabel(`✅ รับเคสโดย @${interaction.user.username}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  try {
    await interaction.update({ components: [disabledRow] });
  } catch (e) {
    await interaction.reply({ content: "รับเคสเรียบร้อยแล้วค่ะ", ephemeral: true });
  }

  await logEvent("report_claimed", {
    channelId,
    staffId:  staffId,
    guildId:  interaction.guildId,
  });

  // แอด permission ทีมงานเข้าห้องแชท
  try {
    const chatChannel = await interaction.client.channels.fetch(channelId);
    if (chatChannel) {
      await chatChannel.permissionOverwrites.create(staffId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });

      // แจ้งในห้องแชทว่าทีมงานรับเรื่องแล้ว
      await chatChannel.send(`<@${staffId}> รับเรื่องเรียบร้อยค่ะ 🙏`);
    }
  } catch (err) {
    console.error("[secret-chat] handleClaimCase permission error:", err);
  }
}

// ============================================================================
// MODULE EXPORT & EVENT SUBSCRIPTIONS
// ============================================================================
function setupSecretChat(client) {

  client.once(Events.ClientReady, async () => {
    await runCrashRecovery(client);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;
    if (message.content.trim() !== "b!reset-match") return;

    try { await message.delete(); } catch (e) {}

    const embed = new EmbedBuilder()
      .setColor("#D2B48C")
      .setTitle("☕ โต๊ะลับฉบับ Bear Cafe")
      .setDescription(
        "บรรยากาศคาเฟ่กำลังดีเลย...\nอยากหาใครสักคนมานั่งคุยด้วยไหมคะ?\n\nกดปุ่มด้านล่างเพื่อเข้าสู่ระบบสุ่มแชท ✨"
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(JOIN_QUEUE_CUSTOM_ID)
        .setLabel("☕ ค้นหาโต๊ะลับ")
        .setStyle(ButtonStyle.Primary)
    );

    await message.channel.send({ embeds: [embed], components: [row] });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === JOIN_QUEUE_CUSTOM_ID) {
      await handleJoinQueue(interaction);
    } else if (interaction.customId === LEAVE_TABLE_CUSTOM_ID) {
      await handleLeaveTable(interaction);
    } else if (interaction.customId === REPORT_USER_CUSTOM_ID) {
      await handleReportUser(interaction);
    } else if (interaction.customId.startsWith(CLAIM_CASE_CUSTOM_ID + ":")) {
      await handleClaimCase(interaction);
    }
  });

  // Garbage Collection เมื่อแอดมินลบห้องเอง
  client.on(Events.ChannelDelete, async (channel) => {
    const members = tableMembers.get(channel.id);
    if (members) {
      const [uA, uB] = Array.from(members);
      await logEvent("channel_deleted", {
        channelId: channel.id,
        userId:    uA ?? null,
        partnerId: uB ?? null,
        metadata:  { ended_by: "admin" },
      });
      clearSessionTimers(channel.id);
      for (const memberId of members) activeUsers.delete(memberId);
      tableMembers.delete(channel.id);
      console.log(`[secret-chat] GC: cleaned up manually deleted channel ${channel.id}`);
    }
  });

  console.log("[secret-chat] Module loaded successfully");
}

module.exports = { setupSecretChat };
