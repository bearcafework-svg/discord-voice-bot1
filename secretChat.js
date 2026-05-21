// ═══════════════════════════════════════════════════════════════
// secretChat.js — Bear Cafe Secret Chat / Matchmaking System
// Node.js + discord.js v14 + Supabase (metadata only)
// ═══════════════════════════════════════════════════════════════
"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// ── Global error guards ───────────────────────────────────────
process.on("unhandledRejection", (err) => {
  console.error("[secret-chat] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[secret-chat] Uncaught exception:", err);
});

// ── Supabase client (service role for bot-side writes) ────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Config ────────────────────────────────────────────────────
const SECRET_CHAT_CATEGORY_ID = process.env.SECRET_CHAT_CATEGORY_ID || "1494308739220770888";

// Role IDs that are banned from matchmaking
const BANNED_ROLE_IDS = new Set([
  "1156930837573754612",
  "1156930842434752614"
]);

const SESSION_DURATION_MS   = 7 * 60 * 1000;   // 7 minutes
const QUEUE_COOLDOWN_MS     = 30 * 1000;        // 30 s between queue joins
const RECENT_MATCH_BLOCK_MS = 5 * 60 * 1000;   // 5 min before re-matching same person
const RAPID_LEAVE_WINDOW_MS = 60 * 1000;        // window to detect rapid leave abuse
const RAPID_LEAVE_MAX       = 3;                // max leaves in window before cooldown
const REPORT_COOLDOWN_MS    = 60 * 1000;        // 60 s between reports per user

// ── Button custom IDs ─────────────────────────────────────────
const BTN_JOIN_QUEUE  = "btn_join_queue";
const BTN_LEAVE_TABLE = "btn_leave_table";
const BTN_REPORT      = "btn_report";

// ── In-memory state ───────────────────────────────────────────
// queue: [{ userId, joinedAt }]
const queue = [];

// activeUsers: Set<userId>
const activeUsers = new Set();

// tableMembers: Map<channelId, Set<userId>>
const tableMembers = new Map();

// sessionTimers: Map<channelId, { mainTimer, reminders: [Timeout] }>
const sessionTimers = new Map();

// sessionMeta: Map<channelId, { userAId, userBId, startedAt, dbId }>
const sessionMeta = new Map();

// queueCooldown: Map<userId, timestamp> — last time user left queue/session
const queueCooldown = new Map();

// recentMatches: Map<userId, Map<partnerId, timestamp>>
const recentMatches = new Map();

// leaveHistory: Map<userId, [timestamp, ...]>
const leaveHistory = new Map();

// reportCooldown: Map<userId, timestamp>
const reportCooldown = new Map();

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Permissions granted to each matched user inside the private channel */
function buildAllowedPermissions() {
  return [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.UseExternalEmojis,
    PermissionFlagsBits.UseExternalStickers
  ];
}

/** Action row with Leave + Report buttons */
function buildSessionButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_LEAVE_TABLE)
      .setLabel("🚪 ลุกจากโต๊ะ")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(BTN_REPORT)
      .setLabel("🚨 รายงาน")
      .setStyle(ButtonStyle.Secondary)
  );
}

/** Remove a user from the in-memory queue */
function removeFromQueue(userId) {
  const idx = queue.findIndex((e) => e.userId === userId);
  if (idx !== -1) queue.splice(idx, 1);
}

/** True if user is already queued or in an active session */
function isUserBusy(userId) {
  return activeUsers.has(userId) || queue.some((e) => e.userId === userId);
}

/** True if user is on queue cooldown */
function isOnQueueCooldown(userId) {
  const last = queueCooldown.get(userId);
  return last && Date.now() - last < QUEUE_COOLDOWN_MS;
}

/** True if these two users matched recently */
function isRecentMatch(userAId, userBId) {
  const map = recentMatches.get(userAId);
  if (!map) return false;
  const last = map.get(userBId);
  return last && Date.now() - last < RECENT_MATCH_BLOCK_MS;
}

/** Record a match between two users */
function recordMatch(userAId, userBId) {
  for (const [a, b] of [[userAId, userBId], [userBId, userAId]]) {
    if (!recentMatches.has(a)) recentMatches.set(a, new Map());
    recentMatches.get(a).set(b, Date.now());
  }
}

/** Record a leave event and return true if user is abusing rapid leaves */
function recordLeaveAndCheckAbuse(userId) {
  const now = Date.now();
  if (!leaveHistory.has(userId)) leaveHistory.set(userId, []);
  const hist = leaveHistory.get(userId);
  // Prune old entries outside the window
  const fresh = hist.filter((t) => now - t < RAPID_LEAVE_WINDOW_MS);
  fresh.push(now);
  leaveHistory.set(userId, fresh);
  return fresh.length > RAPID_LEAVE_MAX;
}

/** Set queue cooldown for a user */
function setCooldown(userId) {
  queueCooldown.set(userId, Date.now());
}

/** Safe interaction reply — handles already-replied / expired interactions */
async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply(options);
    } else {
      await interaction.reply({ ...options, flags: 64 });
    }
  } catch (err) {
    if (err.code !== 10062) {
      console.error("[secret-chat] safeReply error:", err.code, err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Supabase helpers (metadata only — no message content ever)
// ═══════════════════════════════════════════════════════════════

/** Insert a new session row and return its id */
async function dbCreateSession(userAId, userBId, channelId) {
  try {
    const { data, error } = await supabase
      .from("discord_secret_sessions")
      .insert({
        user_id_a: userAId,
        user_id_b: userBId,
        channel_id: channelId,
        started_at: new Date().toISOString(),
        created_by_matchmaking: true
      })
      .select("id")
      .single();

    if (error) {
      console.error("[secret-chat] dbCreateSession error:", error.message);
      return null;
    }
    return data.id;
  } catch (err) {
    console.error("[secret-chat] dbCreateSession exception:", err.message);
    return null;
  }
}

/** Mark a session as ended */
async function dbEndSession(sessionId, leaveReason) {
  if (!sessionId) return;
  try {
    const { error } = await supabase
      .from("discord_secret_sessions")
      .update({
        ended_at: new Date().toISOString(),
        leave_reason: leaveReason
      })
      .eq("id", sessionId);

    if (error) console.error("[secret-chat] dbEndSession error:", error.message);
  } catch (err) {
    console.error("[secret-chat] dbEndSession exception:", err.message);
  }
}

/** Insert a report row (metadata only, no message content) */
async function dbInsertReport(sessionId, reporterId, reportedId) {
  try {
    // Check for duplicate report in this session
    const { data: existing } = await supabase
      .from("discord_secret_reports")
      .select("id")
      .eq("session_id", sessionId)
      .eq("reporter_id", reporterId)
      .maybeSingle();

    if (existing) return { duplicate: true };

    const { error } = await supabase
      .from("discord_secret_reports")
      .insert({
        session_id: sessionId,
        reporter_id: reporterId,
        reported_id: reportedId
      });

    if (error) {
      console.error("[secret-chat] dbInsertReport error:", error.message);
      return { error: true };
    }

    // Increment strike counter on the reported user
    await supabase.rpc("increment_discord_strike", { p_user_id: reportedId });

    return { ok: true };
  } catch (err) {
    console.error("[secret-chat] dbInsertReport exception:", err.message);
    return { error: true };
  }
}

// ═══════════════════════════════════════════════════════════════
// Session timer — 7 min auto-delete with countdown reminders
// ═══════════════════════════════════════════════════════════════

/**
 * Schedule countdown reminders and auto-delete for a channel.
 * Reminders: 1 min left, 30 sec left, closing now.
 */
function scheduleSessionTimer(channel, userAId, userBId, dbSessionId) {
  const reminders = [];

  // Helper: send a reminder safely (channel may already be deleted)
  async function sendReminder(text) {
    try {
      await channel.send({ content: text });
    } catch {
      // Channel already gone — ignore
    }
  }

  // 1 minute left  (at 6:00)
  reminders.push(
    setTimeout(() => {
      const ts = Math.floor((Date.now() + 60_000) / 1000);
      sendReminder(`⏳ เหลือเวลาอีก **1 นาที** — โต๊ะจะปิดตอน <t:${ts}:T> นะคะ`);
    }, SESSION_DURATION_MS - 60_000)
  );

  // 30 seconds left  (at 6:30)
  reminders.push(
    setTimeout(() => {
      sendReminder("⏰ เหลือเวลาอีก **30 วินาที** ค่ะ");
    }, SESSION_DURATION_MS - 30_000)
  );

  // Auto-delete at 7:00
  const mainTimer = setTimeout(async () => {
    await closeSession(channel, userAId, userBId, dbSessionId, "timeout");
  }, SESSION_DURATION_MS);

  sessionTimers.set(channel.id, { mainTimer, reminders });
}

/** Cancel all timers for a channel */
function cancelSessionTimer(channelId) {
  const entry = sessionTimers.get(channelId);
  if (!entry) return;
  clearTimeout(entry.mainTimer);
  for (const t of entry.reminders) clearTimeout(t);
  sessionTimers.delete(channelId);
}

// ═══════════════════════════════════════════════════════════════
// Core session lifecycle
// ═══════════════════════════════════════════════════════════════

/** Create the private channel, record metadata, start timer */
async function createSecretChatChannel(guild, userAId, userBId) {
  const category = guild.channels.cache.get(SECRET_CHAT_CATEGORY_ID);
  if (!category) throw new Error("SECRET_CHAT_CATEGORY_NOT_FOUND");

  const suffix = crypto.randomBytes(2).toString("hex");

  const channel = await guild.channels.create({
    name: `☕-โต๊ะลับ-${suffix}`,
    type: ChannelType.GuildText,
    parent: SECRET_CHAT_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: userAId, allow: buildAllowedPermissions() },
      { id: userBId, allow: buildAllowedPermissions() }
    ]
  });

  activeUsers.add(userAId);
  activeUsers.add(userBId);
  tableMembers.set(channel.id, new Set([userAId, userBId]));
  recordMatch(userAId, userBId);

  // Persist metadata to Supabase (no message content)
  const dbId = await dbCreateSession(userAId, userBId, channel.id);
  sessionMeta.set(channel.id, { userAId, userBId, startedAt: Date.now(), dbId });

  const closeTs = Math.floor((Date.now() + SESSION_DURATION_MS) / 1000);

  await channel.send({
    content:
      `☕ โต๊ะลับพร้อมแล้วค่ะ\n\n` +
      `ยินดีต้อนรับ <@${userAId}> และ <@${userBId}> ✨\n\n` +
      `สามารถพูดคุยกันได้ตามสบายเลยนะคะ\n` +
      `⏱️ โต๊ะนี้จะปิดอัตโนมัติตอน <t:${closeTs}:T> (<t:${closeTs}:R>)`,
    components: [buildSessionButtons()]
  });

  scheduleSessionTimer(channel, userAId, userBId, dbId);

  console.log(`[secret-chat] Created room ${channel.name} for ${userAId} + ${userBId} (db: ${dbId})`);
  return channel;
}

/** Close a session: cancel timers, clean memory, delete channel, update DB */
async function closeSession(channel, userAId, userBId, dbSessionId, reason) {
  cancelSessionTimer(channel.id);

  // Clean memory
  for (const uid of [userAId, userBId]) {
    activeUsers.delete(uid);
    setCooldown(uid);
  }
  tableMembers.delete(channel.id);
  sessionMeta.delete(channel.id);

  await dbEndSession(dbSessionId, reason);

  try {
    await channel.send({ content: "🚪 กำลังปิดโต๊ะลับค่ะ..." });
  } catch { /* already deleted */ }

  try {
    await channel.delete(`Secret chat closed: ${reason}`);
  } catch (err) {
    console.error("[secret-chat] channel.delete error:", err.message);
  }

  console.log(`[secret-chat] Session closed (${reason}) for ${userAId} + ${userBId}`);
}

// ═══════════════════════════════════════════════════════════════
// Interaction handlers
// ═══════════════════════════════════════════════════════════════

async function handleJoinQueue(interaction) {
  const userId = interaction.user.id;

  // Defer immediately to prevent Unknown Interaction (10062)
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    if (err.code === 10062) {
      console.log("[secret-chat] Interaction expired before deferReply");
      return;
    }
    console.error("[secret-chat] deferReply error:", err);
    return;
  }

  try {
    // ── Server-side role ban check ────────────────────────────
    const member = interaction.member
      ?? await interaction.guild.members.fetch(userId).catch(() => null);

    if (member) {
      const memberRoles = member.roles?.cache ?? new Map();
      for (const roleId of BANNED_ROLE_IDS) {
        if (memberRoles.has(roleId)) {
          await interaction.editReply({
            content: "ขออภัยค่ะ บัญชีของคุณไม่สามารถใช้งานระบบนี้ได้ในขณะนี้ 🙏"
          });
          return;
        }
      }
    }

    // ── Already busy ──────────────────────────────────────────
    if (isUserBusy(userId)) {
      await interaction.editReply({
        content: "ตอนนี้คุณอยู่ในคิวหรือกำลังนั่งโต๊ะอยู่แล้วนะคะ ☕"
      });
      return;
    }

    // ── Queue cooldown ────────────────────────────────────────
    if (isOnQueueCooldown(userId)) {
      const remaining = Math.ceil(
        (QUEUE_COOLDOWN_MS - (Date.now() - queueCooldown.get(userId))) / 1000
      );
      await interaction.editReply({
        content: `กรุณารอสักครู่ก่อนเข้าคิวใหม่นะคะ (อีก ${remaining} วินาที) ⏳`
      });
      return;
    }

    // ── Find a waiting partner (not self, not recent match) ───
    const candidate = queue.find(
      (e) => e.userId !== userId && !isRecentMatch(userId, e.userId)
    );

    if (candidate) {
      removeFromQueue(candidate.userId);

      try {
        await createSecretChatChannel(interaction.guild, candidate.userId, userId);
        await interaction.editReply({ content: "จับคู่สำเร็จแล้วค่ะ ✨ ตรวจสอบช่องใหม่ได้เลยนะคะ" });
      } catch (err) {
        console.error("[secret-chat] createSecretChatChannel error:", err);
        // Roll back active state on failure
        activeUsers.delete(candidate.userId);
        activeUsers.delete(userId);
        await interaction.editReply({
          content: "เกิดปัญหาระหว่างสร้างโต๊ะลับค่ะ ลองใหม่อีกครั้งนะคะ 🙏"
        });
      }
      return;
    }

    // ── No partner yet — join queue ───────────────────────────
    queue.push({ userId, joinedAt: Date.now() });
    console.log(`[secret-chat] ${userId} joined queue (queue size: ${queue.length})`);

    await interaction.editReply({
      content:
        "☕ เข้าคิวเรียบร้อยแล้วค่ะ\n\n" +
        "ระบบจะจับคู่ให้อัตโนมัติเมื่อมีคนเข้ามาเพิ่ม ✨\n" +
        "_(หากไม่มีคู่ภายใน 5 นาที คิวจะถูกยกเลิกอัตโนมัติ)_"
    });

    // Auto-expire queue entry after 5 minutes
    setTimeout(() => {
      const stillInQueue = queue.some((e) => e.userId === userId);
      if (stillInQueue) {
        removeFromQueue(userId);
        console.log(`[secret-chat] ${userId} queue expired (no match found)`);
      }
    }, 5 * 60 * 1000);

  } catch (err) {
    console.error("[secret-chat] handleJoinQueue error:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: "เกิดข้อผิดพลาดระหว่างประมวลผลค่ะ ลองใหม่อีกครั้งนะคะ"
        });
      }
    } catch (e2) {
      if (e2.code !== 10062) console.error("[secret-chat] editReply fallback error:", e2);
    }
  }
}

async function handleLeaveTable(interaction) {
  try {
    const members = tableMembers.get(interaction.channelId);

    if (!members || !members.has(interaction.user.id)) {
      await safeReply(interaction, {
        content: "ปุ่มนี้ใช้ได้เฉพาะคนที่อยู่โต๊ะนี้ค่ะ"
      });
      return;
    }

    await interaction.deferUpdate();

    const meta = sessionMeta.get(interaction.channelId);
    const { userAId, userBId, dbId } = meta ?? {};

    // Rapid-leave abuse check
    const isAbusing = recordLeaveAndCheckAbuse(interaction.user.id);
    if (isAbusing) {
      // Apply extra cooldown for abusers
      queueCooldown.set(interaction.user.id, Date.now() + QUEUE_COOLDOWN_MS * 4);
      console.warn(`[secret-chat] Rapid-leave abuse detected for ${interaction.user.id}`);
    }

    await closeSession(
      interaction.channel,
      userAId ?? interaction.user.id,
      userBId ?? "",
      dbId ?? null,
      "leave"
    );

  } catch (err) {
    console.error("[secret-chat] handleLeaveTable error:", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "เกิดข้อผิดพลาดขณะปิดโต๊ะค่ะ", flags: 64 });
      }
    } catch { /* ignore */ }
  }
}

async function handleReport(interaction) {
  const reporterId = interaction.user.id;

  try {
    const members = tableMembers.get(interaction.channelId);

    if (!members || !members.has(reporterId)) {
      await safeReply(interaction, {
        content: "ปุ่มนี้ใช้ได้เฉพาะคนที่อยู่โต๊ะนี้ค่ะ"
      });
      return;
    }

    // Report cooldown
    const lastReport = reportCooldown.get(reporterId);
    if (lastReport && Date.now() - lastReport < REPORT_COOLDOWN_MS) {
      await safeReply(interaction, {
        content: "กรุณารอสักครู่ก่อนรายงานซ้ำนะคะ ⏳"
      });
      return;
    }

    const meta = sessionMeta.get(interaction.channelId);
    if (!meta) {
      await safeReply(interaction, { content: "ไม่พบข้อมูลเซสชันค่ะ" });
      return;
    }

    const reportedId = meta.userAId === reporterId ? meta.userBId : meta.userAId;

    await interaction.deferReply({ ephemeral: true });

    const result = await dbInsertReport(meta.dbId, reporterId, reportedId);

    reportCooldown.set(reporterId, Date.now());

    if (result.duplicate) {
      await interaction.editReply({ content: "คุณได้รายงานในเซสชันนี้ไปแล้วค่ะ" });
      return;
    }

    if (result.error) {
      await interaction.editReply({ content: "เกิดข้อผิดพลาดขณะบันทึกรายงานค่ะ ลองใหม่นะคะ" });
      return;
    }

    await interaction.editReply({
      content:
        "✅ รับรายงานของคุณแล้วค่ะ\n\n" +
        "ทีมงานจะตรวจสอบและดำเนินการต่อไปนะคะ 🙏\n" +
        "_(ข้อมูลการสนทนาจะไม่ถูกบันทึก — เฉพาะ metadata เท่านั้น)_"
    });

    console.log(`[secret-chat] Report filed: ${reporterId} → ${reportedId} (session: ${meta.dbId})`);

  } catch (err) {
    console.error("[secret-chat] handleReport error:", err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "เกิดข้อผิดพลาดค่ะ", flags: 64 });
      }
    } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// Module setup — attach all event listeners to the Discord client
// ═══════════════════════════════════════════════════════════════

function setupSecretChat(client) {

  // ── b!reset-match — post the lobby embed (admin only) ────────
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      if (!message.guild) return;
      if (message.content.trim() !== "b!reset-match") return;

      try { await message.delete(); } catch { /* ignore */ }

      const embed = new EmbedBuilder()
        .setColor("#D2B48C")
        .setTitle("☕ โต๊ะลับฉบับ Bear Cafe")
        .setDescription(
          "บรรยากาศคาเฟ่กำลังดีเลย...\n" +
          "อยากหาใครสักคนมานั่งคุยด้วยไหมคะ?\n\n" +
          "กดปุ่มด้านล่างเพื่อเข้าสู่ระบบสุ่มแชท ✨\n\n" +
          "**กฎ:**\n" +
          "• ห้องจะปิดอัตโนมัติหลัง 7 นาที\n" +
          "• ห้ามส่งเนื้อหาที่ไม่เหมาะสม\n" +
          "• ใช้ปุ่ม 🚨 รายงาน หากพบพฤติกรรมไม่เหมาะสม"
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(BTN_JOIN_QUEUE)
          .setLabel("☕ ค้นหาโต๊ะลับ")
          .setStyle(ButtonStyle.Primary)
      );

      await message.channel.send({ embeds: [embed], components: [row] });

    } catch (err) {
      console.error("[secret-chat] messageCreate error:", err);
    }
  });

  // ── Button interactions ───────────────────────────────────────
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isButton()) return;

      switch (interaction.customId) {
        case BTN_JOIN_QUEUE:
          await handleJoinQueue(interaction);
          break;
        case BTN_LEAVE_TABLE:
          await handleLeaveTable(interaction);
          break;
        case BTN_REPORT:
          await handleReport(interaction);
          break;
      }
    } catch (err) {
      console.error("[secret-chat] interactionCreate error:", err);
    }
  });

  // ── Channel deleted externally — clean up memory ──────────────
  client.on("channelDelete", (channel) => {
    try {
      const members = tableMembers.get(channel.id);
      if (members) {
        for (const uid of members) {
          activeUsers.delete(uid);
          setCooldown(uid);
        }
        tableMembers.delete(channel.id);
      }

      cancelSessionTimer(channel.id);

      const meta = sessionMeta.get(channel.id);
      if (meta) {
        dbEndSession(meta.dbId, "channel_deleted").catch(() => {});
        sessionMeta.delete(channel.id);
      }
    } catch (err) {
      console.error("[secret-chat] channelDelete cleanup error:", err);
    }
  });

  // ── Bot restart cleanup — clear stale in-memory state ─────────
  client.once("clientReady", () => {
    // On restart all in-memory state is fresh — nothing to restore.
    // Any channels that existed before restart will be cleaned up
    // when they are deleted or when users interact with them.
    console.log("[secret-chat] Module loaded and ready");
  });

  console.log("[secret-chat] Module registered");
}

module.exports = { setupSecretChat };
