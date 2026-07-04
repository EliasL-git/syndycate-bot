import express from "express";
import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import { ai } from "./services/OpenAIService";
import { AI_COMMAND, IMAGE_COMMAND, handleSlashAI, handleSlashImage, buildPrefixHandler } from "./commands/ai-handler";

const applicationId = process.env.DISCORD_CLIENT_ID!;

const app = express();
app.get("/health", (_req: any, res: any) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    keys: ai.getStats(),
  });
});
app.get("/", (_req: any, res: any) => res.send("Syndycate is alive"));

// Force re-sync slash commands to ALL guilds
app.get("/sync", async (_req: any, res: any) => {
  try {
    const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN!);
    const guilds = await rest.get(Routes.userGuilds()) as any[];
    const results: any[] = [];
    for (const guild of guilds) {
      await rest.put(Routes.applicationGuildCommands(applicationId, guild.id), { body: [AI_COMMAND, IMAGE_COMMAND] });
      results.push({ guild: guild.name, id: guild.id, ok: true });
      console.log(`[Sync] Registered /sai in ${guild.name} (${guild.id})`);
    }
    res.json({ ok: true, synced: results.length, results });
  } catch (err: any) {
    console.error("[Sync] Failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function main() {
  const port = parseInt(process.env.PORT ?? "3000", 10);

  const { loaded, healthy } = ai.bootstrap();
  console.log(`[Bootstrap] FreeAI loaded=${loaded} healthy=${healthy}`);

  client.on("ready", async () => {
    console.log(`[Discord] Logged in as ${client.user?.tag}`);

    // Sync /sai to ALL guilds on every start
    const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN!);
    const guilds = client.guilds.cache;
    console.log(`[Discord] Syncing /sai to ${guilds.size} guild(s)…`);

    for (const [, guild] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(applicationId, guild.id), { body: [AI_COMMAND, IMAGE_COMMAND] });
        console.log(`[Discord] ✓ /sai registered in ${guild.name}`);
      } catch (err: any) {
        console.error(`[Discord] ✗ Failed for ${guild.name}: ${err.message}`);
      }
    }

    console.log("[Discord] Command sync complete");
    client.user?.setActivity("/sai | Syndycate", { type: 3 });
  });

  client.on("interactionCreate", async (interaction: any) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "simage") {
    try { await handleSlashImage(interaction); }
    catch (err: any) {
      console.error("[Discord] Image error:", err);
      const msg = "Something went wrong.";
      if (interaction.replied || interaction.deferred) await interaction.editReply(msg).catch(() => {});
      else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
    return;
  }
  if (interaction.commandName !== "sai") return;
    try { await handleSlashAI(interaction); }
    catch (err: any) {
      console.error("[Discord] Slash error:", err);
      const msg = "Something went wrong.";
      if (interaction.replied || interaction.deferred) await interaction.editReply(msg).catch(() => {});
      else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  });

  const prefixHandler = buildPrefixHandler();
  client.on("messageCreate", async (msg: any) => {
    if (msg.author.bot) return;
    if (!msg.content.startsWith("!")) return;
    await prefixHandler(msg);
  });

  app.listen(port, () => console.log(`[Express] :${port}/health | /sync`));

  if (!process.env.DISCORD_BOT_TOKEN) { console.error("FATAL: DISCORD_BOT_TOKEN missing"); process.exit(1); }
  await client.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch((err) => { console.error("[Fatal]", err); process.exit(1); });
