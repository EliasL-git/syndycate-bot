/**
 * AI Handler — slash commands + prefix handler for Syndycate bot.
 *
 * Features:
 *   /sai   — chat with AI (key rotation via RotationEngine)
 *   /simage — generate image via Stable Horde (kudos-boosted)
 *   /stats — show kudos balance, queue, job stats
 *   !ask   — prefix chat
 *   !img   — prefix image gen
 *
 * Image jobs are persisted in Postgres so they survive reboots.
 * ETA is returned as a unix timestamp.
 * Kudos bidding scales with available balance (1–50 per gen).
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder,
  EmbedBuilder,
} from "discord.js";
import { ai } from "../services/OpenAIService";
import { rateLimiter } from "../engine/RateLimiter";
import { STABLE_HORDE_BASE, STABLE_HORDE_KEY } from "../engine/HordeClient";
import { calculateBid, getKudosBalance, recordGeneration, recordBid } from "../services/KudosManager";
import {
  createJob,
  updateJobStatus,
  getActiveJobs,
  getJobStats,
  initDB,
  updateResumeMsgId,
} from "../services/Database";

// ── Slash Command Definitions ────────────────────────────────────────────────

export const AI_COMMAND = new SlashCommandBuilder()
  .setName("sai")
  .setDescription("Chat with Syndycate AI — free providers, auto key rotation")
  .addStringOption((o) =>
    o.setName("prompt").setDescription("Your message").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("max_tokens")
      .setDescription("Max response length (200–4096)")
      .setRequired(false)
      .setMinValue(200)
      .setMaxValue(4096),
  )
  .toJSON();

export const IMAGE_COMMAND = new SlashCommandBuilder()
  .setName("simage")
  .setDescription("Generate an image with Stable Horde (kudos-boosted)")
  .addStringOption((o) =>
    o.setName("prompt").setDescription("Image description").setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("model")
      .setDescription("Stable Diffusion model")
      .setRequired(false)
      .addChoices(
        { name: "AlbedoBase XL (SDXL)", value: "AlbedoBase XL (SDXL)" },
        { name: "Juggernaut XL", value: "Juggernaut XL" },
        { name: "Stable Diffusion XL", value: "stable_diffusion" },
        { name: "Stable Diffusion 1.5", value: "SD 1.5" },
      ),
  )
  .toJSON();

export const STATS_COMMAND = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Show bot stats — kudos, queue, job history")
  .toJSON();

// ── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM =
  "You are Syndycate — the AI for people. Helpful, witty, irreverent. " +
  "Use Discord markdown. Keep answers under 500 words unless asked.";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRateLimit(retryAfterMs: number): string {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return `Slow down! Try again in ${seconds}s.`;
}

function unixEtaFromNow(waitSeconds: number): number {
  return Math.floor(Date.now() / 1000) + waitSeconds;
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ── Per-user image lock ──────────────────────────────────────────────────────
// Prevents the same user from spamming multiple concurrent image requests.

const activeImageUsers = new Set<string>();

function tryLock(userId: string): boolean {
  if (activeImageUsers.has(userId)) return false;
  activeImageUsers.add(userId);
  return true;
}

function unlock(userId: string): void {
  activeImageUsers.delete(userId);
}

// ── Image Generation ─────────────────────────────────────────────────────────

interface GenerateResult {
  buffer: Buffer;
  kudosCost: number;
  imageUrl: string;
}

async function generateImage(
  prompt: string,
  model: string | undefined,
  userId: string,
  channelId: string,
  onProgress?: (msg: string) => void,
): Promise<GenerateResult> {
  // 1. Decide kudos bid based on our balance
  const kudosBid = calculateBid();
  const balance = getKudosBalance();

  console.log(
    `[Horde] Generating — balance: ${balance}, bid: ${kudosBid}, model: ${model ?? "default"}`,
  );

  // 2. Submit generation request
  const body: any = {
    prompt,
    params: {
      width: 512,
      height: 512,
      steps: 30,
      cfg_scale: 7.5,
      sampler_name: "k_euler_a",
    },
    nsfw: false,
    censor_nsfw: true,
    models: model ? [model] : ["AlbedoBase XL (SDXL)"],
    r2: true,
    trusted_workers: true,
  };

  // Only include kudos bid if we have balance (> 0 means registered key)
  if (kudosBid > 0) {
    body.kudos = kudosBid;
  }

  const submitRes = await fetch(`${STABLE_HORDE_BASE}/generate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: STABLE_HORDE_KEY,
    },
    body: JSON.stringify(body),
  });

  const submitData = await submitRes.json() as any;
  const jobId = submitData.id;
  if (!jobId) throw new Error(submitData.message || "Failed to submit job");

  const kudosCost = submitData.kudos ?? kudosBid;
  const initialEta = unixEtaFromNow(submitData.wait_time ?? 30);

  // 3. Persist job in Postgres (for session resume)
  await createJob({
    jobId,
    userId,
    channelId,
    prompt,
    model: model ?? undefined,
    etaUnix: initialEta,
  });

  // 4. Poll for completion (max 5 min)
  let lastQueue = -1;
  let lastWait = -1;
  const maxAttempts = 60;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 5000));

    const checkRes = await fetch(
      `${STABLE_HORDE_BASE}/generate/check/${jobId}`,
    );
    const checkData = await checkRes.json() as any;

    if (checkData.done) {
      // Get the result
      const statusRes = await fetch(
        `${STABLE_HORDE_BASE}/generate/status/${jobId}`,
      );
      const statusData = await statusRes.json() as any;

      const img = statusData.generations?.[0];
      if (!img?.img) throw new Error("No image in response");

      // img is a URL when r2=true, download it
      let buffer: Buffer;
      let imageUrl = "";
      if (img.img.startsWith("http")) {
        imageUrl = img.img.split("?")[0]; // strip query params for clean URL
        const imgRes = await fetch(img.img);
        buffer = Buffer.from(await imgRes.arrayBuffer());
      } else {
        buffer = Buffer.from(img.img, "base64");
      }

      const finalKudos = checkData.kudos ?? kudosCost;

      // Update DB + track kudos earned from this generation
      await updateJobStatus(jobId, "done", {
        kudosCost: finalKudos,
        imageUrl,
      });
      await recordGeneration(finalKudos);

      return { buffer, kudosCost: finalKudos, imageUrl };
    }

    if (checkData.faulted) {
      await updateJobStatus(jobId, "faulted");
      throw new Error("Generation faulted on the Horde");
    }

    // Progress — unix ETA, only update embed when values change
    const queue = checkData.queue_position ?? 0;
    const wait = checkData.wait_time ?? 0;
    const etaUnix = unixEtaFromNow(wait);

    if (queue !== lastQueue || wait !== lastWait) {
      lastQueue = queue;
      lastWait = wait;

      // Update DB ETA
      await updateJobStatus(jobId, "processing", { etaUnix });

      const isRegistered = STABLE_HORDE_KEY !== "0000000000";
      const bidLabel = isRegistered
        ? `🔑 registered (bid: ${kudosBid})`
        : `🔓 anonymous`;
      onProgress?.(
        `Generating... <t:${etaUnix}:R> (queue: #${queue}, ETA: <t:${etaUnix}:f>)\n${bidLabel}`,
      );
    }
  }

  await updateJobStatus(jobId, "timeout");
  throw new Error("Image generation timed out (5 min)");
}

// ── Slash: /sai ──────────────────────────────────────────────────────────────

export async function handleSlashAI(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  const limit = rateLimiter.check(userId);
  if (!limit.allowed) {
    await interaction.reply({
      content: formatRateLimit(limit.retryAfterMs!),
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  const prompt = interaction.options.getString("prompt", true)!;
  const maxTokens = interaction.options.getInteger("max_tokens", false) ?? 1024;

  try {
    const { content, provider } = await ai.chat({
      messages: [{ role: "user", content: prompt }],
      systemPrompt: SYSTEM,
      maxTokens,
    });
    await interaction.editReply(`${content}\n\n-# ${provider}`);
  } catch (err: any) {
    await interaction.editReply(`Error: ${err.message}`);
  }
}

// ── Slash: /simage ───────────────────────────────────────────────────────────

export async function handleSlashImage(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  const limit = rateLimiter.check(userId);
  if (!limit.allowed) {
    await interaction.reply({
      content: formatRateLimit(limit.retryAfterMs!),
      ephemeral: true,
    });
    return;
  }

  if (!tryLock(userId)) {
    await interaction.reply({
      content: "⏳ You already have an image generating. Wait for it to finish!",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  const prompt = interaction.options.getString("prompt", true)!;
  const model = interaction.options.getString("model", false) ?? undefined;

  try {
    const { buffer, kudosCost } = await generateImage(
      prompt,
      model,
      userId,
      interaction.channelId,
      async (msg) => {
        await interaction.editReply(msg).catch(() => {});
      },
    );

    const attachment = new AttachmentBuilder(buffer, {
      name: "syndycate-image.png",
    });
    const imageMsg = await interaction.editReply({
      content: prompt,
      files: [attachment],
    });

    // Ping the user with a link to the image message
    const link = `https://discord.com/channels/${interaction.guildId ?? "@me"}/${interaction.channelId}/${imageMsg.id}`;
    await interaction.followUp({
      content: `<@${userId}> 🖼️ Your image is generated! View it at ${link}\n-# kudos spent: ${kudosCost}`,
      allowedMentions: { users: [userId] },
    });
  } catch (err: any) {
    await interaction.editReply(`Error generating image: ${err.message}`);
  } finally {
    unlock(userId);
  }
}

// ── Slash: /stats ────────────────────────────────────────────────────────────

export async function handleSlashStats(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const [balance, jobStats, hordeHealth] = await Promise.all([
      Promise.resolve(getKudosBalance()),
      getJobStats(),
      fetch(`${STABLE_HORDE_BASE}/status/heartbeat`)
        .then((r) => r.json())
        .catch(() => ({ queue: "?", threads: 0, version: "?" })),
    ]);

    const embed = new EmbedBuilder()
      .setTitle("⚡ Syndycate Stats")
      .setColor(0xff6b35)
      .addFields(
        {
          name: "💰 Kudos Balance",
          value: `\`${balance}\``,
          inline: true,
        },
        {
          name: "🖼️ Images Generated",
          value: `\`${jobStats.completed}\``,
          inline: true,
        },
        {
          name: "⏳ Active Jobs",
          value: `\`${jobStats.active}\``,
          inline: true,
        },
        {
          name: "📊 Total Kudos Spent",
          value: `\`${jobStats.totalKudosSpent}\``,
          inline: true,
        },
        {
          name: "❌ Faulted/Timeout",
          value: `\`${jobStats.faulted}\``,
          inline: true,
        },
        {
          name: "🌐 Horde Queue",
          value: `\`${(hordeHealth as any).queue ?? "?"}\` waiting, \`${(hordeHealth as any).threads ?? "?"}\` workers`,
          inline: true,
        },
      )
      .setFooter({ text: `Horde v${(hordeHealth as any).version ?? "?"}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`Error fetching stats: ${err.message}`);
  }
}

// ── Session Resume ───────────────────────────────────────────────────────────

/**
 * On boot, find any pending/processing image jobs in Postgres and
 * poll them until they finish or time out. This handles reboots gracefully.
 */
export async function resumeImageSessions(
  client: any,
): Promise<void> {
  await initDB();
  const active = await getActiveJobs();

  if (active.length === 0) {
    console.log("[Resume] No active image jobs to resume");
    return;
  }

  console.log(`[Resume] Resuming ${active.length} active image job(s)`);

  for (const job of active) {
    // Fire-and-forget resume per job (don't block boot)
    resumeSingleJob(job, client).catch((err) => {
      console.error(`[Resume] Job ${job.jobId} failed: ${err.message}`);
    });
  }
}

async function resumeSingleJob(
  job: { jobId: string; userId: string; channelId: string; prompt: string; resumeMsgId?: string | null },
  client: any,
): Promise<void> {
  // Lock this user so they can't queue another while we're resuming
  tryLock(job.userId);
  const maxAttempts = 60;

  // Send initial progress message to the channel
  let progressMsgId = job.resumeMsgId ?? null;
  try {
    const channel = await client.channels.fetch(job.channelId);
    if (channel?.isTextBased()) {
      const msg = await channel.send({
        content: `🔄 Resuming generation for <@${job.userId}>...\n${job.prompt}`,
      });
      progressMsgId = msg.id;
      // Store the message ID so we can edit it on next boot too
      await updateResumeMsgId(job.jobId, progressMsgId!);
    }
  } catch {
    console.warn(`[Resume] Could not send initial progress for ${job.jobId}`);
  }

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 5_000));

    try {
      const checkRes = await fetch(
        `${STABLE_HORDE_BASE}/generate/check/${job.jobId}`,
      );
      const checkData = await checkRes.json() as any;

      if (checkData.done) {
        const statusRes = await fetch(
          `${STABLE_HORDE_BASE}/generate/status/${job.jobId}`,
        );
        const statusData = await statusRes.json() as any;
        const img = statusData.generations?.[0];

        if (img?.img) {
          const imageUrl = img.img.startsWith("http")
            ? img.img.split("?")[0]
            : "";
          const finalKudos = checkData.kudos ?? 0;

          await updateJobStatus(job.jobId, "done", {
            kudosCost: finalKudos,
            imageUrl,
          });
          await recordGeneration(finalKudos);

          try {
            const channel = await client.channels.fetch(job.channelId);
            if (channel?.isTextBased()) {
              const buffer = img.img.startsWith("http")
                ? Buffer.from(await (await fetch(img.img)).arrayBuffer())
                : Buffer.from(img.img, "base64");

              const attachment = new AttachmentBuilder(buffer, {
                name: "syndycate-image.png",
              });

              // Build the message link
              const guildId = channel.guild?.id ?? "@me";

              if (progressMsgId) {
                try {
                  const existingMsg = await channel.messages.fetch(progressMsgId);
                  await existingMsg.edit({
                    content: `${job.prompt}`,
                    files: [attachment],
                  });
                  // Ping user with link
                  const link = `https://discord.com/channels/${guildId}/${job.channelId}/${progressMsgId}`;
                  await channel.send({
                    content: `<@${job.userId}> 🖼️ Your image is generated! View it at ${link}\n-# kudos earned: ${finalKudos} (resumed after reboot)`,
                    allowedMentions: { users: [job.userId] },
                  });
                } catch {
                  // Message deleted — send new
                  const newMsg = await channel.send({
                    content: `${job.prompt}`,
                    files: [attachment],
                  });
                  const link = `https://discord.com/channels/${guildId}/${job.channelId}/${newMsg.id}`;
                  await channel.send({
                    content: `<@${job.userId}> 🖼️ Your image is generated! View it at ${link}\n-# kudos earned: ${finalKudos} (resumed after reboot)`,
                    allowedMentions: { users: [job.userId] },
                  });
                }
              } else {
                const newMsg = await channel.send({
                  content: `${job.prompt}`,
                  files: [attachment],
                });
                const link = `https://discord.com/channels/${guildId}/${job.channelId}/${newMsg.id}`;
                await channel.send({
                  content: `<@${job.userId}> 🖼️ Your image is generated! View it at ${link}\n-# kudos earned: ${finalKudos} (resumed after reboot)`,
                  allowedMentions: { users: [job.userId] },
                });
              }
            }
          } catch {
            console.warn(`[Resume] Could not deliver job ${job.jobId} to channel ${job.channelId}`);
          }
        } else {
          await updateJobStatus(job.jobId, "faulted");
        }
        unlock(job.userId);
        return;
      }

      if (checkData.faulted) {
        await updateJobStatus(job.jobId, "faulted");
        unlock(job.userId);
        return;
      }

      const etaUnix = unixEtaFromNow(checkData.wait_time ?? 0);
      await updateJobStatus(job.jobId, "processing", { etaUnix });

      // Update the progress message in Discord
      if (progressMsgId) {
        try {
          const channel = await client.channels.fetch(job.channelId);
          if (channel?.isTextBased()) {
            const existingMsg = await channel.messages.fetch(progressMsgId);
            const bidLabel = STABLE_HORDE_KEY !== "0000000000"
              ? `🔑 registered`
              : `🔓 anonymous`;
            await existingMsg.edit({
              content: `🔄 Resuming... <t:${etaUnix}:R> (queue: #${checkData.queue_position ?? "?"}, ETA: <t:${etaUnix}:f>)\n${job.prompt}\n-# ${bidLabel}`,
            }).catch(() => {});
          }
        } catch {
          // Channel/message gone — continue polling, deliver at end
        }
      }
    } catch (err: any) {
      console.warn(`[Resume] Poll error for ${job.jobId}: ${err.message}`);
    }
  }

  await updateJobStatus(job.jobId, "timeout");
  unlock(job.userId);
}

// ── Prefix Handler ───────────────────────────────────────────────────────────

export function buildPrefixHandler() {
  return async (msg: any): Promise<void> => {
    if (msg.author.bot) return;
    const userId = msg.author.id;
    const trimmed = msg.content.trim();

    // !ask
    const ask = trimmed.match(/^!ask\s+(.+)$/i);
    if (ask) {
      const limit = rateLimiter.check(userId);
      if (!limit.allowed) {
        await msg.reply(formatRateLimit(limit.retryAfterMs!));
        return;
      }
      const reply = await msg.channel.send({ content: "Thinking…" });
      try {
        const { content, provider } = await ai.chat({
          messages: [{ role: "user", content: ask[1] }],
          systemPrompt: SYSTEM,
        });
        await reply.edit(`${content}\n\n-# ${provider}`);
      } catch (err: any) {
        await reply.edit(`Error: ${err.message}`);
      }
    }

    // !img
    const img = trimmed.match(/^!img\s+(.+)$/i);
    if (img) {
      const limit = rateLimiter.check(userId);
      if (!limit.allowed) {
        await msg.reply(formatRateLimit(limit.retryAfterMs!));
        return;
      }

      if (!tryLock(userId)) {
        await msg.reply("⏳ You already have an image generating. Wait for it to finish!");
        return;
      }

      const reply = await msg.channel.send({ content: "⚡ Generating image..." });
      try {
      const { buffer, kudosCost } = await generateImage(
        img[1],
        undefined,
        userId,
        msg.channel.id,
        async (progressMsg) => {
          await reply.edit(progressMsg).catch(() => {});
        },
      );
      const attachment = new AttachmentBuilder(buffer, {
        name: "syndycate-image.png",
      });
      await reply.edit({
        content: img[1],
        files: [attachment],
      });

      // Ping the user with a link to the image message
      const link = `https://discord.com/channels/${msg.guildId ?? "@me"}/${msg.channel.id}/${reply.id}`;
      await msg.channel.send({
        content: `<@${userId}> 🖼️ Your image is generated! View it at ${link}\n-# kudos spent: ${kudosCost}`,
        allowedMentions: { users: [userId] },
      });
      } catch (err: any) {
        await reply.edit(`Error: ${err.message}`);
      } finally {
        unlock(userId);
      }
    }

    // !stats (prefix version)
    if (/^!stats$/i.test(trimmed)) {
      try {
        const balance = getKudosBalance();
        const jobStats = await getJobStats();
        await msg.reply(
          [
            `**⚡ Syndycate Stats**`,
            `💰 Kudos: \`${balance}\``,
            `🖼️ Generated: \`${jobStats.completed}\``,
            `⏳ Active: \`${jobStats.active}\``,
            `💸 Total spent: \`${jobStats.totalKudosSpent}\``,
          ].join("\n"),
        );
      } catch (err: any) {
        await msg.reply(`Error: ${err.message}`);
      }
    }
  };
}
