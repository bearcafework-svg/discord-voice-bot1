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

// ============================================================================
// SYSTEM CONFIGURATION & CONSTANTS
// ============================================================================
// ดึงค่า Category ID จาก Environment Variables
const SECRET_CHAT_CATEGORY_ID = process.env.SECRET_CHAT_CATEGORY_ID; 

const BLOCKED_ROLES = ["1156930837573546126", "1156930842434752614"];
const SESSION_DURATION_MS = 7 * 60 * 1000; // ระยะเวลาหลัก 7 นาที
const WARNING_1MIN_MS = 6 * 60 * 1000;      // เวลาแจ้งเตือน 1 นาทีสุดท้าย
const WARNING_30SEC_MS = 6.5 * 60 * 1000;   // เวลาแจ้งเตือน 30 วินาทีสุดท้าย

const JOIN_QUEUE_CUSTOM_ID = "btn_join_queue";
const LEAVE_TABLE_CUSTOM_ID = "btn_leave_table";
const REPORT_USER_CUSTOM_ID = "btn_report_user";

// ============================================================================
// IN-MEMORY STATE MANAGEMENT (VOLATILE)
// ============================================================================
const queue = [];
const activeUsers = new Set();
const tableMembers = new Map();
const sessionTimers = new Map();
const recentMatches = new Map(); // ป้องกันการจับคู่ซ้ำซ้อนรวดเร็ว
const spamTracker = new Map(); // ติดตามการคลิกเพื่อป้องกันการแสปม

// ============================================================================
// SUPABASE REST INITIALIZATION (NO WEBSOCKETS ALLOWED)
// ============================================================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: { enabled: false }, // บังคับปิด Realtime ตามเงื่อนไขของ Koyeb
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);

// ============================================================================
// GLOBAL ERROR HANDLING (PREVENT RUNTIME CRASHES)
// ============================================================================
process.on("unhandledRejection", (error) => {
  console.error("[secret-chat] Unhandled rejection:", error);
});
process.on("uncaughtException", (error) => {
  console.error("[secret-chat] Uncaught exception:", error);
});

// ============================================================================
// UTILITY & HELPER FUNCTIONS
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
    if (timers.warning1m) clearTimeout(timers.warning1m);
    if (timers.warning30s) clearTimeout(timers.warning30s);
    if (timers.termination) clearTimeout(timers.termination);
    sessionTimers.delete(channelId);
  }
}

function isUserBusy(userId) {
  return activeUsers.has(userId) || queue.includes(userId);
}

function checkSpamRateLimit(userId) {
  const now = Date.now();
  const timestamps = spamTracker.get(userId) || [];
  // กรองเอาเฉพาะที่กดเข้ามาภายใน 60 วินาที
  const recent = timestamps.filter((time) => now - time < 60000); 
  recent.push(now);
  spamTracker.set(userId, recent);
  return recent.length > 3; // ระงับชั่วคราวหากพยายามมากกว่า 3 ครั้งต่อนาที
}

// ============================================================================
// ORPHAN RECOVERY & GARBAGE COLLECTION ON STARTUP
// ============================================================================
async function runCrashRecovery(client) {
  if (!SECRET_CHAT_CATEGORY_ID) return;
  try {
    console.log("[secret-chat] Initiating orphan channel recovery...");
    const guilds = client.guilds.cache.values();
    for (const guild of guilds) {
      const category = guild.channels.cache.get(SECRET_CHAT_CATEGORY_ID);
      if (!category) continue;

      // ค้นหาช่องที่มีชื่อตามแพตเทิร์นและลบทิ้ง
      const orphanedChannels = category.children.cache.filter(
        (channel) => channel.name.includes("☕-โต๊ะลับ-")
      );

      for (const [id, channel] of orphanedChannels) {
        await channel.delete("Automated cleanup of orphaned channel post-restart");
        console.log(`[secret-chat] Purged orphaned channel: ${channel.name}`);
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
  
  // สร้าง Timestamp ป้องกันการออกแล้วเข้าใหม่เจอคนเดิมทันที (5 นาที)
  recentMatches.set(`${userAId}-${userBId}`, Date.now());
  recentMatches.set(`${userBId}-${userAId}`, Date.now());

  // คำนวณเวลาหมดอายุเพื่อแสดงเป็น Discord Timestamp
  const endTime = Math.floor((Date.now() + SESSION_DURATION_MS) / 1000);

  await channel.send({
    content: `☕ โต๊ะลับพร้อมแล้วค่ะ\n\nยินดีต้อนรับ <@${userAId}> และ <@${userBId}> ✨\nระยะเวลาสนทนา 7 นาที (หมดเวลา: <t:${endTime}:R>)\nสามารถพูดคุยกันได้ตามสบายเลยนะคะ`,
    components: [buildActionRow()]
  });

  // สร้างระบบจับเวลาอิสระ (Asynchronous Timers)
  const timerData = {
    warning1m: setTimeout(async () => {
      try { await channel.send("⏳ **เหลือเวลาอีก 1 นาที** โต๊ะจะปิดอัตโนมัติค่ะ"); } catch (e) {}
    }, WARNING_1MIN_MS),

    warning30s: setTimeout(async () => {
      try { await channel.send("⚠️ **เหลือเวลาอีก 30 วินาที** เตรียมบอกลากันได้เลยนะคะ!"); } catch (e) {}
    }, WARNING_30SEC_MS),

    termination: setTimeout(async () => {
      try {
        await channel.send("🛑 หมดเวลาสนทนาแล้วค่ะ กำลังทำความสะอาดโต๊ะ...");
        clearSessionTimers(channel.id);
        tableMembers.delete(channel.id);
        activeUsers.delete(userAId);
        activeUsers.delete(userBId);
        await channel.delete("Session timeout reached");
      } catch (e) {}
    }, SESSION_DURATION_MS)
  };

  sessionTimers.set(channel.id, timerData);
  console.log(`[secret-chat] Created room ${channel.name} for ${userAId} + ${userBId}`);
  return channel;
}

// ============================================================================
// INTERACTION HANDLERS (DEFENSIVE PROGRAMMING)
// ============================================================================
async function handleJoinQueue(interaction) {
  const userId = interaction.user.id;

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (error) {
    if (error.code === 10062) return; // หมดเวลาตอบสนอง ให้ยุติทันที
    return;
  }

  // 1. กระบวนการตรวจสอบแบนระดับเซิร์ฟเวอร์ (Server-Side Role Ban)
  if (interaction.member && interaction.member.roles) {
    const hasBlockedRole = BLOCKED_ROLES.some((roleId) =>
      interaction.member.roles.cache.has(roleId)
    );
    if (hasBlockedRole) {
      return await interaction.editReply("ขออภัยค่ะ สิทธิ์ของคุณไม่สามารถใช้งานโต๊ะลับได้ในขณะนี้ ☕");
    }
  }

  // 2. การตรวจสอบสถานะการเข้าซ้ำและการแสปม (State & Anti-Abuse)
  if (isUserBusy(userId)) {
    return await interaction.editReply("ตอนนี้คุณอยู่ในคิวหรือกำลังนั่งโต๊ะอยู่แล้วนะคะ ☕");
  }
  if (checkSpamRateLimit(userId)) {
    return await interaction.editReply("คุณทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่ค่ะ ⏳");
  }

  // 3. กลไกการค้นหาและจับคู่ที่ป้องกันการเจอบุคคลเดิมซ้ำทันที
  const partnerIndex = queue.findIndex((id) => {
    if (id === userId) return false; // กันการจับคู่กับตัวเอง
    const lastMatchTime = recentMatches.get(`${userId}-${id}`);
    if (lastMatchTime && (Date.now() - lastMatchTime < 300000)) return false; // โคลดาวน์คู่สนทนาเดิม 5 นาที
    return true;
  });

  if (partnerIndex!== -1) {
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
    // 4. รอในคิวอย่างสงบสุข
    queue.push(userId);
    console.log(`[secret-chat] ${userId} joined queue. Total waiting: ${queue.length}`);
    await interaction.editReply("☕ เข้าคิวเรียบร้อยแล้วค่ะ\n\nระบบจะจับคู่ให้อัตโนมัติเมื่อมีคนเข้ามาเพิ่ม ✨");
  }
}

async function handleLeaveTable(interaction) {
  const channelId = interaction.channelId;
  const members = tableMembers.get(channelId);

  if (!members ||!members.has(interaction.user.id)) {
    return await interaction.reply({ content: "ปุ่มนี้ใช้ได้เฉพาะคนที่อยู่โต๊ะนี้ค่ะ", ephemeral: true });
  }

  try {
    await interaction.deferUpdate();
    // ทำลายกลไกตัวจับเวลาทันทีเพื่อคืนหน่วยความจำและป้องกันบัค
    clearSessionTimers(channelId);
    
    for (const memberId of members) {
      activeUsers.delete(memberId);
    }
    tableMembers.delete(channelId);

    console.log(`[secret-chat] Channel ${channelId} deleted by ${interaction.user.id}`);
    await interaction.channel.delete(`Secret chat closed by ${interaction.user.id}`);
  } catch (error) {
    console.error("[secret-chat] Leave error:", error);
  }
}

async function handleReportUser(interaction) {
  const channelId = interaction.channelId;
  const reporterId = interaction.user.id;
  const members = tableMembers.get(channelId);

  if (!members ||!members.has(reporterId)) {
    return await interaction.reply({ content: "ไม่สามารถดำเนินการได้", ephemeral: true });
  }

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (e) { return; }

  // ดึงหมายเลขไอดีของคนที่ถูกแจ้งรีพอร์ต
  const membersArray = Array.from(members);
  const reportedId = membersArray.find((id) => id!== reporterId);

  if (!reportedId) {
    return await interaction.editReply("ไม่พบผู้ใช้งานที่สามารถรายงานได้");
  }

  try {
    // ส่งข้อมูล Metadata ไปยัง Supabase (เก็บเฉพาะ ID ห้ามเก็บข้อความ)
    const { error } = await supabase
     .from("secret_chat_reports")
     .insert([
        {
          reporter_id: reporterId,
          reported_id: reportedId,
          channel_id: channelId
        }
      ]);

    if (error) throw error;

    await interaction.editReply("⚠️ ระบบได้รับรายงานเรียบร้อยแล้วค่ะ ข้อมูลถูกบันทึกเพื่อตรวจสอบโดยแอดมิน");
  } catch (dbError) {
    console.error("[secret-chat] Supabase Report Error:", dbError);
    await interaction.editReply("เกิดข้อผิดพลาดในการส่งรายงาน แต่ระบบได้บันทึกความพยายามนี้ไว้แล้วค่ะ");
  }
}

// ============================================================================
// MODULE EXPORT & EVENT SUBSCRIPTIONS
// ============================================================================
function setupSecretChat(client) {
  
  // Hook ระบบกู้คืนเซิร์ฟเวอร์
  client.once(Events.ClientReady, async () => {
    await runCrashRecovery(client);
  });

  // สร้างหน้าต่างข้อความประกาศ Lobby
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot ||!message.guild) return;
    if (message.content.trim()!== "b!reset-match") return;

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

  // Router ตรวจจับการกดปุ่มทั้งหมด
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    if (interaction.customId === JOIN_QUEUE_CUSTOM_ID) {
      await handleJoinQueue(interaction);
    } else if (interaction.customId === LEAVE_TABLE_CUSTOM_ID) {
      await handleLeaveTable(interaction);
    } else if (interaction.customId === REPORT_USER_CUSTOM_ID) {
      await handleReportUser(interaction);
    }
  });

  // Garbage Collection เมื่อแอดมินลบห้องทิ้งด้วยตนเอง
  client.on(Events.ChannelDelete, (channel) => {
    const members = tableMembers.get(channel.id);
    if (members) {
      clearSessionTimers(channel.id);
      for (const memberId of members) activeUsers.delete(memberId);
      tableMembers.delete(channel.id);
    }
  });

  console.log("[secret-chat] Module loaded successfully");
}

module.exports = { setupSecretChat };
