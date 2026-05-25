// ═══════════════════════════════════════════════════════════
//  donate.js — ระบบยอดโดเนท Top 10 + เช็คยอดส่วนตัว
// ═══════════════════════════════════════════════════════════
const { createClient } = require("@supabase/supabase-js");

const GUILD_ID          = "1144251788493602848";
const EXCLUDED_USER_ID  = "944920660759707658"; // ไม่จัดอันดับ แต่ดูยอดตัวเองได้

// Cooldown 24 ชม. (ms)
const REFRESH_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let lastRefreshAt = 0; // timestamp ที่กด 🔄 ครั้งล่าสุด

// ── ตัวเลข Unicode Math Sans-Serif ──────────────────────────
const MATH_DIGITS = ["𝟢","𝟣","𝟤","𝟥","𝟦","𝟧","𝟨","𝟩","𝟪","𝟫"];

/**
 * แปลงตัวเลขปกติ → Unicode math digits พร้อม comma ทุก 3 หลัก
 * เช่น 1200 → "𝟣,𝟤𝟢𝟢"
 */
function toMathNum(n) {
  const str = Math.round(n).toLocaleString("en-US"); // "1,200"
  return str.replace(/\d/g, d => MATH_DIGITS[parseInt(d)]);
}

// ── ดึง Avatar URL ของ Guild Member ─────────────────────────
async function getAvatarUrl(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    // ลำดับ: Server Avatar → Global Avatar → Default
    return (
      member.displayAvatarURL({ size: 128, extension: "png" }) ||
      `https://cdn.discordapp.com/embed/avatars/0.png`
    );
  } catch {
    return `https://cdn.discordapp.com/embed/avatars/0.png`;
  }
}

// ── ดึง Username ของ Guild Member ───────────────────────────
async function getUsername(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.user.username;
  } catch {
    return userId;
  }
}

// ── ดึงข้อมูลยอดโดเนทรวม Top N จาก Supabase ────────────────
async function fetchTopDonors(supabase, limit = 10) {
  const { data, error } = await supabase
    .from("trading_history")
    .select("member_id, amount")
    .neq("member_id", EXCLUDED_USER_ID);

  if (error) throw new Error(error.message);

  // รวม amount ต่อ member_id
  const totals = {};
  for (const row of data) {
    const mid = row.member_id;
    totals[mid] = (totals[mid] || 0) + parseFloat(row.amount || 0);
  }

  // เรียงมากไปน้อย
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

// ── ดึงยอดรวม + รายการล่าสุด ของ user คนนึง ─────────────────
async function fetchUserDonation(supabase, userId) {
  const { data, error } = await supabase
    .from("trading_history")
    .select("member_id, amount, transaction")
    .eq("member_id", userId)
    .order("transaction", { ascending: false });

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;

  const total = data.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const latest = data[0]; // รายการล่าสุด
  return { total, latestAmount: parseFloat(latest.amount || 0), latestDate: latest.transaction };
}

// ── สร้าง Component body สำหรับ Top Donate ──────────────────
async function buildTopDonateComponents(guild, supabase) {
  const top10 = await fetchTopDonors(supabase, 10);

  const rankEmojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const topEmojis  = [
    "<a:top_one:1150848398774247564>",
    "<a:top_two:1150848396190568448>",
    "<a:top_three:1150849072299769896>",
  ];

  const components = [
    // Banner
    {
      type: 12,
      items: [{
        media: {
          url: "https://cdn.discordapp.com/attachments/1164188104182210670/1185678831219126355/TopDonate_-_bearcafe.png?ex=6a160176&is=6a14aff6&hm=43f5b048b2a25b0c576626e0f81a7c983e7e5a269884235626b9f87a832a984b&"
        }
      }]
    },
    { type: 14, spacing: 2 },
    // Header + ปุ่มเช็คยอด
    {
      type: 9,
      components: [{
        type: 10,
        content: "## <a:bellbag:1185624186132103178>︲__` 𝖳𝗈𝗉 𝖣𝗈𝗇𝖺𝗍𝖾 ₊ ท็อปโดเนท 𓂃 `__ \n-# <:line:1144701793989840997> มาดูกันว่าใครสายเปย์ที่สุดในคาเฟ่หมี หากยอดโดเนทของคุณครบ **1,000 บาท** ขึ้นไปก็รับยศ <@&1185550863448682579> ผ่านห้อง <#1181547381582463046> ได้เลยค่ะ <:cuteplant:1152834055528783872>"
      }],
      accessory: {
        style: 1,
        type: 2,
        label: "เช็คยอดของคุณ",
        flow: { actions: [] },
        custom_id: "donate_check_self"
      }
    },
    { type: 14, divider: false, spacing: 1 },
  ];

  // อันดับ 1–3 (มี avatar)
  for (let i = 0; i < Math.min(3, top10.length); i++) {
    const [uid, total] = top10[i];
    const username = await getUsername(guild, uid);
    const avatarUrl = await getAvatarUrl(guild, uid);

    components.push({
      type: 9,
      components: [{
        type: 10,
        content: `### ${topEmojis[i]}⠀:⠀<@${uid}>⠀—⠀\` ${username} \`⠀𝖽𝗈𝗇𝖺𝗍𝖾𝖽 __${toMathNum(total)}__ 𝖻𝖺𝗁𝗍 .`
      }],
      accessory: {
        type: 11,
        media: { url: avatarUrl }
      }
    });
    components.push({ type: 14, spacing: 2 });
  }

  // อันดับ 4–10 (ข้อความล้วน รวมกัน)
  if (top10.length > 3) {
    const lines = [];
    for (let i = 3; i < top10.length; i++) {
      const [uid, total] = top10[i];
      const username = await getUsername(guild, uid);
      lines.push(
        `### ${rankEmojis[i]}⠀:⠀<@${uid}>⠀—⠀\` ${username} \`⠀𝖽𝗈𝗇𝖺𝗍𝖾𝖽 __${toMathNum(total)}__ 𝖻𝖺𝗁𝗍 .`
      );
    }
    components.push({ type: 10, content: lines.join("\n") });
    components.push({ type: 14, spacing: 2 });
  }

  // Footer: วันที่รีเซ็ต + ปุ่ม 🔄
  const resetText = lastRefreshAt
    ? `<t:${Math.floor(lastRefreshAt / 1000)}:F>`
    : "ยังไม่ได้รีเซ็ต";

  components.push({
    type: 9,
    components: [{
      type: 10,
      content: `**รีเซ็ตข้อมูลล่าสุด:** ${resetText}`
    }],
    accessory: {
      style: 2,
      type: 2,
      emoji: { name: "🔄" },
      flow: { actions: [] },
      custom_id: "donate_refresh"
    }
  });

  return components;
}

// ── ส่ง / อัปเดต Top Donate Message ────────────────────────
async function sendOrUpdateTopDonate(channel, guild, supabase, existingMessage = null) {
  const components = await buildTopDonateComponents(guild, supabase);
  const body = {
    flags: 32768,
    components: [{ type: 17, components }]
  };

  if (existingMessage) {
    await existingMessage.edit(body);
  } else {
    await channel.send(body);
  }
}

// ══════════════════════════════════════════════════════════════
//  setupDonate — เชื่อมกับ client
// ══════════════════════════════════════════════════════════════
function setupDonate(client) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── คำสั่ง b!reset-donate (Owner เท่านั้น) ─────────────────
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.content.trim().toLowerCase() !== "b!reset-donate") return;

    const OWNER_ID = process.env.OWNER_ID; // ใส่ใน .env ว่า Owner Discord ID คือใคร
    if (message.author.id !== OWNER_ID) {
      return message.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะ Owner เท่านั้นค่ะ", flags: 64 });
    }

    try {
      await message.delete().catch(() => {});
      const guild = message.guild;
      await sendOrUpdateTopDonate(message.channel, guild, supabase);
    } catch (err) {
      console.error("[donate] reset-donate error:", err);
      message.channel.send("❌ เกิดข้อผิดพลาดในการโหลดข้อมูลค่ะ").catch(() => {});
    }
  });

  // ── Interaction: ปุ่ม 🔄 refresh ────────────────────────────
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    // ── ปุ่ม 🔄 อัปเดต Top Donate ───────────────────────────
    if (interaction.customId === "donate_refresh") {
      const now = Date.now();
      const diff = now - lastRefreshAt;

      if (lastRefreshAt > 0 && diff < REFRESH_COOLDOWN_MS) {
        // ยัง Cooldown อยู่
        const nextTs = Math.floor((lastRefreshAt + REFRESH_COOLDOWN_MS) / 1000);
        return interaction.reply({
          content: `## <:bear_star1:1152782839671169184>︲คุณสามารถกดรีเซ็ตข้อมูลได้อีก <t:${nextTs}:R>`,
          flags: 64
        });
      }

      await interaction.deferUpdate();

      try {
        lastRefreshAt = now;
        const guild = interaction.guild;
        const components = await buildTopDonateComponents(guild, supabase);
        await interaction.editReply({
          flags: 32768,
          components: [{ type: 17, components }]
        });
      } catch (err) {
        console.error("[donate] refresh error:", err);
      }
      return;
    }

    // ── ปุ่ม เช็คยอดของคุณ ──────────────────────────────────
    if (interaction.customId === "donate_check_self") {
      const guild = interaction.guild;
      const userId = interaction.user.id;

      try {
        await interaction.deferReply({ flags: 64 });
        const result = await fetchUserDonation(supabase, userId);

        if (!result || result.total === 0) {
          return interaction.editReply({
            content: "## <:bear_star1:1152782839671169184>︲คุณยังไม่ได้โดเนทให้กับคาเฟ่หมีนะคะ !"
          });
        }

        const { total, latestAmount, latestDate } = result;
        const avatarUrl = await getAvatarUrl(guild, userId);
        const username  = await getUsername(guild, userId);

        // หา rank ของ user นี้
        let rankText = "x";
        let titlePrefix = "นายทุนหมีฝึกหัดอันดับ";

        if (userId === EXCLUDED_USER_ID) {
          rankText = "x";
        } else {
          const allTop = await fetchTopDonors(supabase, 9999);
          const idx = allTop.findIndex(([uid]) => uid === userId);
          rankText = idx >= 0 ? toMathNum(idx + 1) : "x";
        }

        if (total >= 1000) {
          titlePrefix = "<@&1185550863448682579> อันดับ";
        }

        // จำนวนสมาชิก guild
        const memberCount = guild.memberCount;

        // แปลง transaction (YYYY-MM-DD) → Unix timestamp
        let latestTs = Math.floor(Date.now() / 1000);
        if (latestDate) {
          const d = new Date(latestDate);
          if (!isNaN(d)) latestTs = Math.floor(d.getTime() / 1000);
        }

        const content =
          `## <:HoneyPot:1301533095203438683>︲__\` ${username}'𝗌 𝖽𝗈𝗇𝖺𝗍𝗂𝗈𝗇 𝗍𝗈𝗍𝖺𝗅 . 𓂃 \`__ \n` +
          `-# <:line:1144701793989840997> ${titlePrefix} **${rankText}** จาก ${toMathNum(memberCount)} คน ` +
          `โดเนทสะสม **${toMathNum(total)} บาท** ` +
          `และล่าสุดแอบโยนปลาแซลมอนมาอีก **${toMathNum(latestAmount)} บาท** เมื่อ <t:${latestTs}:R> <:cuteplant:1152834055528783872>`;

        return interaction.editReply({
          flags: 32768,
          components: [{
            type: 17,
            components: [
              { type: 14, spacing: 2 },
              {
                type: 9,
                components: [{ type: 10, content }],
                accessory: { type: 11, media: { url: avatarUrl } }
              },
              { type: 14, spacing: 2 }
            ]
          }]
        });

      } catch (err) {
        console.error("[donate] check-self error:", err);
        return interaction.editReply({ content: "❌ เกิดข้อผิดพลาดค่ะ กรุณาลองใหม่อีกครั้ง" });
      }
    }
  });
}

module.exports = { setupDonate };
