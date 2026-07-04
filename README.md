# Syndycate Discord Bot

AI-powered Discord bot with **automatic API key rotation** to bypass rate limits.

## Commands

| Command | Usage |
|---------|-------|
| `/ai prompt:...` | Slash command — provider defaults to auto |
| `/ai provider:openai prompt:hello` | Force ChatGPT |
| `/ai provider:anthropic prompt:...` | Force Claude |
| `!ask <prompt>` | Prefix — auto-picks best available provider |
| `!claude <prompt>` | Prefix — forces Claude |

## Key Rotation Strategy

1. **LRU least-recently-used dispatch**: distributes requests across the pool
2. **429 honour` involves exactly the server-supplied `Retry-After` delta
3. **Exponential back-off** otherwise: 60s → 120s → 240s → … capped at 20 min
4. **401/403 = key death**: permanently removed from the pool (invalid / revoked)
5. **Auto-failover**: if OpenAI is all 429'd and Claude has capacity, the call succeeds on Claude

## Setup

1. Create a Discord application at [discord.com/developers](https://discord.com/developers/applications)
2. Enable **Message Content Intent** in the Developer Portal
3. Set these env vars in Render:
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `OPENAI_API_KEYS` (comma or newline separated)
   - `ANTHROPIC_API_KEYS` (optional)
4. Deploy on Render — free tier is fine

## Health check

- `GET /health` — JSON with key pool status, uptime
- `GET /` — alive probe for Render

## Tech

- `discord.js` v14 + TypeScript
- `express` / health server
- `openai` + `@anthropic-ai/sdk`
- Docker (Node 22 Alpine)
- Render free tier
