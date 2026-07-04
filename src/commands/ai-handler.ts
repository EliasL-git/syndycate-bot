/**
 * AI Handler — slash commands + prefix handler for Syndycate bot.
 *
 * Features:
 *   /sai   — chat with AI (key rotation via RotationEngine)
 *   /simg  — generate image via Fal.ai (key rotation via RotationEngine)
 *   /stats — show bot stats
 *   !ask   — prefix chat
 *   !img   — prefix image gen
 */

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder,
  EmbedBuilder,
} from "discord.js";
import { ai } from "../services/OpenAIService";
import { rateLimiter } from "../engine/RateLimiter";
import { falGenerate } from "../engine/FalClient";
import { keyEngine } from "../engine/RotationEngine";
import {
  createJob,
  updateJobStatus,
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
  .setName("simg")
  .setDescription("Generate an image with Fal.ai (Flux Schnell / Flux LoRA)")
  .addStringOption((o) =>
    o.setName("prompt").setDescription("Image description").setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("model")
      .setDescription("Fal.ai model")
      .setRequired(false)
      .addChoices(
        { name: "Flux Schnell (fast, free)", value: "fal-ai/flux/schnell" },
        { name: "Flux LoRA (style transfer)", value: "fal-ai/flux-lora" },
      ),
  )
  .addStringOption((o) =>
    o
      .setName("lora")
      .setDescription("LoRA name for flux-lora model (e.g. 'disney', 'anime', 'pixel')")
      .setRequired(false),
  )
  .addIntegerOption((o) =>
    o
      .setName("width")
      .setDescription("Image width (256–1024)")
      .setRequired(false)
      .setMinValue(256)
      .setMaxValue(1024),
  )
  .addIntegerOption((o) =>
    o
      .setName("height")
      .setDescription("Image height (256–1024)")
      .setRequired(false)
      .setMinValue(256)
      .setMaxValue(1024),
  )
  .toJSON();

export const STATS_COMMAND = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Show bot stats — images generated, job history")
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

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ── Per-user image lock ──────────────────────────────────────────────────────

const activeImageUsers = new Set<string>();

function tryLock(userId: string): boolean {
  if (activeImageUsers.has(userId)) return false;
  activeImageUsers.add(userId);
  return true;
}

function unlock(userId: string): void {
  activeImageUsers.delete(userId);
}

// ── Image Generation via Fal.ai ──────────────────────────────────────────────

interface GenerateResult {
  buffer: Buffer;
  imageUrl: string;
}

async function generateImage(
  prompt: string,
  model: string | undefined,
  lora: string | undefined,
  width: number | undefined,
  height: number | undefined,
  userId: string,
  channelId: string,
  onProgress?: (msg: string) => void,
): Promise<GenerateResult> {
  // Resolve model
  const selectedModel = model ?? "fal-ai/flux/schnell";
  const useLora = selectedModel === "fal-ai/flux-lora" && lora;
  const w = width ?? 512;
  const h = height ?? 512;

  console.log(
    `[Fal] Generating — model: ${selectedModel}, lora: ${lora ?? "none"}, size: ${w}x${h}`,
  );

  // Generate via Fal.ai (handles key rotation internally)
  const key = keyEngine.acquire("fal")?.key;
  if (!key) throw new Error("No Fal.ai keys available");
  
  const result = await falGenerate(key, {
    prompt,
    image_size: w === h ? (w >= 768 ? "square_hd" : "square") : 
                w > h ? "landscape_16_9" : "portrait_16_9",
    num_inference_steps: 25,
    guidance_scale: 3.5,
    num_images: 1,
    enable_safety_checker: true,
    format: "png",
  }, selectedModel, (status) => {
    onProgress?.(`Generating... ${status}`);
  });

  // Download image
  let buffer: Buffer;
  let imageUrl = "";
  if (result.images[0]?.url.startsWith("http")) {
    imageUrl = result.images[0].url.split("?")[0];
    const imgRes = await fetch(result.images[0].url);
    buffer = Buffer.from(await imgRes.arrayBuffer());
  } else {
    buffer = Buffer.from(result.images[0].url, "base64");
  }

  // Persist job (fast sync — just for stats/history)
  const jobId = `fal_${Date.now()}_${userId}`;
  await createJob({
    jobId,
    userId,
    channelId,
    prompt,
    model: selectedModel,
    etaUnix: Math.floor(Date.now() / 1000) + 5,
  });
  await updateJobStatus(jobId, "done", { imageUrl, kudosCost: 0 });

  return { buffer, imageUrl };
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

// ── Slash: /simg ─────────────────────────────────────────────────────────────

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
  const lora = interaction.options.getString("lora", false) ?? undefined;
  const width = interaction.options.getInteger("width", false) ?? undefined;
  const height = interaction.options.getInteger("height", false) ?? undefined;

  try {
    const { buffer, imageUrl } = await generateImage(
      prompt,
      model,
      lora,
      width,
      height,
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
      content: `<@${userId}> 🖼️ Your image is ready! View it at ${link}\n-# Model: ${model ?? "flux/schnell"}${lora ? ` + LoRA: ${lora}` : ""}`,
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
    const jobStats = await getJobStats();
    const keyStats = keyEngine.stats();

    const embed = new EmbedBuilder()
      .setTitle("⚡ Syndycate Stats")
      .setColor(0xff6b35)
      .addFields(
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
          name: "❌ Faulted/Timeout",
          value: `\`${jobStats.faulted}\``,
          inline: true,
        },
        {
          name: "🔑 AI Keys Loaded",
          value: `\`${keyStats.totalKeys}\` (\`${keyStats.healthyKeys}\` healthy)`,
          inline: true,
        },
        {
          name: "🎨 Fal.ai Keys",
          value: `\`${keyStats.providerBreakdown.fal.total}\` (\`${keyStats.providerBreakdown.fal.healthy}\` healthy)`,
          inline: true,
        },
        {
          name: "💬 Chat Keys",
          value: `\`${keyStats.providerBreakdown.openrouter.total}\` (\`${keyStats.providerBreakdown.openrouter.healthy}\` healthy)`,
          inline: true,
        },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`Error fetching stats: ${err.message}`);
  }
}

// ── Session Resume ───────────────────────────────────────────────────────────
// Fal.ai is fast/sync — no long-running async jobs to resume.
// We just re-deliver any "done" jobs that didn't get sent (edge case: bot crashed after gen, before reply).

export async function resumeImageSessions(client: any): Promise<void> {
  await initDB();
  // Nothing to resume for Fal.ai — generations are synchronous.
  console.log("[Resume] Fal.ai mode — no async jobs to resume");
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

      const reply = await msg.channel.send({ content: "⚡ Generating image…" });
      try {
        const { buffer, imageUrl } = await generateImage(
          img[1],
          undefined,
          undefined,
          undefined,
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
          content: `<@${userId}> 🖼️ Your image is generated! View it at ${link}\n-# Model: flux/schnell`,
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
        const jobStats = await getJobStats();
        const keyStats = keyEngine.stats();
        await msg.reply(
          [
            `**⚡ Syndycate Stats**`,
            `🖼️ Generated: \`${jobStats.completed}\``,
            `⏳ Active: \`${jobStats.active}\``,
            `❌ Faulted: \`${jobStats.faulted}\``,
            `🔑 AI Keys: \`${keyStats.totalKeys}\` (\`${keyStats.healthyKeys}\` healthy)`,
            `  ├─ Fal.ai: \`${keyStats.providerBreakdown.fal.total}\``,
            `  └─ Chat: \`${keyStats.providerBreakdown.openrouter.total}\``,
          ].join("\n"),
        );
      } catch (err: any) {
        await msg.reply(`Error: ${err.message}`);
      }
    }
  };
}