import { SlashCommandBuilder, ChatInputCommandInteraction, AttachmentBuilder } from "discord.js";
import { ai } from "../services/OpenAIService";
import { rateLimiter } from "../engine/RateLimiter";
import { STABLE_HORDE_BASE } from "../engine/HordeClient";

const STABLE_HORDE_KEY = process.env.STABLE_HORDE_API_KEY ?? "0000000000";

export const AI_COMMAND = new SlashCommandBuilder()
  .setName("sai")
  .setDescription("Chat with Syndycate AI — free providers, auto key rotation")
  .addStringOption((o) =>
    o.setName("prompt").setDescription("Your message").setRequired(true)
  )
  .addIntegerOption((o) =>
    o.setName("max_tokens")
     .setDescription("Max response length (200–4096)")
     .setRequired(false)
     .setMinValue(200)
     .setMaxValue(4096)
  )
  .toJSON();

export const IMAGE_COMMAND = new SlashCommandBuilder()
  .setName("simage")
  .setDescription("Generate an image with Stable Horde (free)")
  .addStringOption((o) =>
    o.setName("prompt").setDescription("Image description").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("model")
     .setDescription("Stable Diffusion model")
     .setRequired(false)
     .addChoices(
       { name: "AlbedoBase XL (SDXL)", value: "AlbedoBase XL (SDXL)" },
       { name: "Juggernaut XL", value: "Juggernaut XL" },
       { name: "Stable Diffusion XL", value: "stable_diffusion" },
       { name: "Stable Diffusion 1.5", value: "SD 1.5" },
     )
  )
  .toJSON();

const SYSTEM =
  "You are Syndycate — the AI for people. Helpful, witty, irreverent. " +
  "Use Discord markdown. Keep answers under 500 words unless asked.";

function formatRateLimit(retryAfterMs: number): string {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return `Slow down! Try again in ${seconds}s.`;
}

async function generateImage(
  prompt: string,
  model?: string,
  onProgress?: (msg: string) => void,
): Promise<{ buffer: Buffer; kudosCost: number }> {
  // Submit generation request with kudos-boosted priority
  const submitRes = await fetch(`${STABLE_HORDE_BASE}/generate/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": STABLE_HORDE_KEY },
    body: JSON.stringify({
      prompt: prompt,
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
      // Use kudos for priority — registered keys accumulate kudos,
      // spending them moves us up the queue
      kudos: 50,
      trusted_workers: true,
    }),
  });

  const submitData = await submitRes.json() as any;
  const jobId = submitData.id;
  if (!jobId) throw new Error(submitData.message || "Failed to submit job");

  // Poll for completion (max 5 minutes)
  let kudosCost = submitData.kudos ?? 0;
  let lastQueue = -1;
  let lastWait = -1;
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const checkRes = await fetch(`${STABLE_HORDE_BASE}/generate/check/${jobId}`);
    const checkData = await checkRes.json() as any;

    if (checkData.done) {
      // Get the result
      const statusRes = await fetch(`${STABLE_HORDE_BASE}/generate/status/${jobId}`);
      const statusData = await statusRes.json() as any;

      const img = statusData.generations?.[0];
      if (!img?.img) throw new Error("No image in response");

      // img is a URL when r2=true, download it
      let buffer: Buffer;
      if (img.img.startsWith("http")) {
        const imgRes = await fetch(img.img);
        buffer = Buffer.from(await imgRes.arrayBuffer());
      } else {
        buffer = Buffer.from(img.img, "base64");
      }

      kudosCost = checkData.kudos ?? kudosCost;
      return { buffer, kudosCost };
    }

    // Report progress — only update if queue/wait changed to avoid spamming edits
    const queue = checkData.queue_position ?? "?";
    const wait = checkData.wait_time ?? "?";
    if (queue !== lastQueue || wait !== lastWait) {
      lastQueue = queue;
      lastWait = wait;
      onProgress?.(`⚡ Generating... (queue: #${queue}, ~${wait}s, kudos: ${kudosCost})`);
    }
  }

  throw new Error("Image generation timed out (5 min)");
}

export async function handleSlashAI(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const limit = rateLimiter.check(userId);
  if (!limit.allowed) {
    await interaction.reply({ content: formatRateLimit(limit.retryAfterMs!), ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const prompt    = interaction.options.getString("prompt", true)!;
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

export async function handleSlashImage(interaction: ChatInputCommandInteraction): Promise<void> {
  const userId = interaction.user.id;
  const limit = rateLimiter.check(userId);
  if (!limit.allowed) {
    await interaction.reply({ content: formatRateLimit(limit.retryAfterMs!), ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const prompt = interaction.options.getString("prompt", true)!;
  const model  = interaction.options.getString("model", false) ?? undefined;

  try {
    const { buffer, kudosCost } = await generateImage(prompt, model, async (msg) => {
      await interaction.editReply(msg).catch(() => {});
    });
    const attachment = new AttachmentBuilder(buffer, { name: "syndycate-image.png" });
    await interaction.editReply({
      content: `${prompt}\n-# kudos spent: ${kudosCost}`,
      files: [attachment],
    });
  } catch (err: any) {
    await interaction.editReply(`Error generating image: ${err.message}`);
  }
}

export function buildPrefixHandler() {
  return async (msg: any): Promise<void> => {
    if (msg.author.bot) return;
    const userId = msg.author.id;
    const trimmed = msg.content.trim();

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

    const img = trimmed.match(/^!img\s+(.+)$/i);
    if (img) {
      const limit = rateLimiter.check(userId);
      if (!limit.allowed) {
        await msg.reply(formatRateLimit(limit.retryAfterMs!));
        return;
      }

        const reply = await msg.channel.send({ content: "⚡ Generating image..." });
        try {
          const { buffer, kudosCost } = await generateImage(img[1], undefined, async (progressMsg) => {
            await reply.edit(progressMsg).catch(() => {});
          });
          const attachment = new AttachmentBuilder(buffer, { name: "syndycate-image.png" });
          await reply.edit({ content: `${img[1]}\n-# kudos spent: ${kudosCost}`, files: [attachment] });
        } catch (err: any) {
          await reply.edit(`Error: ${err.message}`);
        }
    }
  };
}
