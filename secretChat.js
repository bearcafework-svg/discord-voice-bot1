const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");

const crypto = require("crypto");

process.on("unhandledRejection", (error) => {
  console.error("[secret-chat] Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("[secret-chat] Uncaught exception:", error);
});

const SECRET_CHAT_CATEGORY_ID = "1494308739220770888";

const JOIN_QUEUE_CUSTOM_ID = "btn_join_queue";
const LEAVE_TABLE_CUSTOM_ID = "btn_leave_table";

const queue = [];
const activeUsers = new Set();
const tableMembers = new Map();

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

function buildLeaveButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(LEAVE_TABLE_CUSTOM_ID)
      .setLabel("🚪 ลุกจากโต๊ะ")
      .setStyle(ButtonStyle.Danger)
  );
}

function removeUserFromQueue(userId) {
  const index = queue.findIndex((id) => id === userId);

  if (index !== -1) {
    queue.splice(index, 1);
  }
}

function isUserBusy(userId) {
  return activeUsers.has(userId) || queue.includes(userId);
}

async function createSecretChatChannel(guild, userAId, userBId) {
  const category = guild.channels.cache.get(SECRET_CHAT_CATEGORY_ID);

  if (!category) {
    throw new Error("SECRET_CHAT_CATEGORY_NOT_FOUND");
  }

  const suffix = crypto.randomBytes(2).toString("hex");

  const channel = await guild.channels.create({
    name: `☕-โต๊ะลับ-${suffix}`,
    type: ChannelType.GuildText,
    parent: SECRET_CHAT_CATEGORY_ID,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: userAId,
        allow: buildAllowedPermissions()
      },
      {
        id: userBId,
        allow: buildAllowedPermissions()
      }
    ]
  });

  activeUsers.add(userAId);
  activeUsers.add(userBId);

  tableMembers.set(channel.id, new Set([userAId, userBId]));

  await channel.send({
    content:
      `☕ โต๊ะลับพร้อมแล้วค่ะ\n\n` +
      `ยินดีต้อนรับ <@${userAId}> และ <@${userBId}> ✨\n\n` +
      `สามารถพูดคุยกันได้ตามสบายเลยนะคะ`,
    components: [buildLeaveButton()]
  });

  console.log(`[secret-chat] Created room ${channel.name} for ${userAId} + ${userBId}`);

  return channel;
}

async function handleJoinQueue(interaction) {

  const userId = interaction.user.id;

  try {

    // IMPORTANT:
    // ตอบ Discord ให้เร็วที่สุด ป้องกัน Unknown Interaction
    await interaction.deferReply({
      ephemeral: true
    });

  } catch (error) {

    // interaction หมดอายุแล้ว
    if (error.code === 10062) {
      console.log("[secret-chat] Interaction expired before deferReply");
      return;
    }

    console.error("[secret-chat] deferReply error:", error);
    return;
  }

  try {

    if (isUserBusy(userId)) {

      await interaction.editReply({
        content: "ตอนนี้คุณอยู่ในคิวหรือกำลังนั่งโต๊ะอยู่แล้วนะคะ ☕"
      });

      return;
    }

    const waitingUserId = queue.find((id) => id !== userId);

    // มีคนรออยู่ → จับคู่
    if (waitingUserId) {

      removeUserFromQueue(waitingUserId);

      try {

        await createSecretChatChannel(
          interaction.guild,
          waitingUserId,
          userId
        );

        await interaction.editReply({
          content: "จับคู่สำเร็จแล้วค่ะ ✨"
        });

      } catch (error) {

        console.error("[secret-chat] create room error:", error);

        activeUsers.delete(waitingUserId);
        activeUsers.delete(userId);

        await interaction.editReply({
          content:
            "เกิดปัญหาระหว่างสร้างโต๊ะลับค่ะ\nลองใหม่อีกครั้งนะคะ"
        });
      }

      return;
    }

    // ยังไม่มีคู่ → เข้าคิว
    queue.push(userId);

    console.log(`[secret-chat] ${userId} joined queue`);

    await interaction.editReply({
      content:
        "☕ เข้าคิวเรียบร้อยแล้วค่ะ\n\n" +
        "ระบบจะจับคู่ให้อัตโนมัติเมื่อมีคนเข้ามาเพิ่ม ✨"
    });

  } catch (error) {

    console.error("[secret-chat] Queue processing error:", error);

    try {

      if (interaction.deferred || interaction.replied) {

        await interaction.editReply({
          content:
            "เกิดข้อผิดพลาดระหว่างประมวลผลค่ะ\nลองใหม่อีกครั้งนะคะ"
        });
      }

    } catch (editError) {

      // กัน Unknown interaction ซ้ำ
      if (editError.code !== 10062) {
        console.error("[secret-chat] editReply error:", editError);
      }
    }
  }
}

async function handleLeaveTable(interaction) {
  try {
    const members = tableMembers.get(interaction.channelId);

    if (!members || !members.has(interaction.user.id)) {
      await interaction.reply({
        content: "ปุ่มนี้ใช้ได้เฉพาะคนที่อยู่โต๊ะนี้ค่ะ",
        flags: 64
      });
      return;
    }

    await interaction.deferUpdate();

    for (const memberId of members) {
      activeUsers.delete(memberId);
    }

    tableMembers.delete(interaction.channelId);

    console.log(
      `[secret-chat] Channel deleted by ${interaction.user.id}`
    );

    await interaction.channel.delete(
      `Secret chat closed by ${interaction.user.id}`
    );

  } catch (error) {
    console.error("[secret-chat] Leave error:", error);

    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "เกิดข้อผิดพลาดขณะปิดโต๊ะค่ะ",
          flags: 64
        });
      }
    } catch {}
  }
}

function setupSecretChat(client) {

  client.on("messageCreate", async (message) => {
    try {

      if (message.author.bot) return;
      if (!message.guild) return;

      if (message.content.trim() !== "b!reset-match") {
        return;
      }

      try {
        await message.delete();
      } catch {}

      const embed = new EmbedBuilder()
        .setColor("#D2B48C")
        .setTitle("☕ โต๊ะลับฉบับ Bear Cafe")
        .setDescription(
          "บรรยากาศคาเฟ่กำลังดีเลย...\n" +
          "อยากหาใครสักคนมานั่งคุยด้วยไหมคะ?\n\n" +
          "กดปุ่มด้านล่างเพื่อเข้าสู่ระบบสุ่มแชท ✨"
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(JOIN_QUEUE_CUSTOM_ID)
          .setLabel("☕ ค้นหาโต๊ะลับ")
          .setStyle(ButtonStyle.Primary)
      );

      await message.channel.send({
        embeds: [embed],
        components: [row]
      });

    } catch (error) {
      console.error("[secret-chat] messageCreate error:", error);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {

      if (!interaction.isButton()) return;

      if (interaction.customId === JOIN_QUEUE_CUSTOM_ID) {
        await handleJoinQueue(interaction);
        return;
      }

      if (interaction.customId === LEAVE_TABLE_CUSTOM_ID) {
        await handleLeaveTable(interaction);
        return;
      }

    } catch (error) {
      console.error("[secret-chat] interactionCreate error:", error);
    }
  });

  client.on("channelDelete", (channel) => {
    try {
      const members = tableMembers.get(channel.id);

      if (members) {
        for (const memberId of members) {
          activeUsers.delete(memberId);
        }

        tableMembers.delete(channel.id);
      }
    } catch (error) {
      console.error("[secret-chat] channelDelete cleanup error:", error);
    }
  });

  console.log("[secret-chat] Module loaded");
}

module.exports = {
  setupSecretChat
};
