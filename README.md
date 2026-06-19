# Groknul Bot

A bold, opinionated, yet helpful Telegram bot that observes group conversations, saves all messages (with edit history and reactions) to MongoDB, and generates AI-powered replies when mentioned or replied to.

The name is inspired by Twitter/X’s Grok. "groknul" also playfully echoes the Russian "грохнул".

## Features

- 🤖 **Context‑aware AI replies**: Uses OpenRouter and a smart router to pick how to respond
- 🧭 **Fast router**: Kimi K2 routes between actions (reply, long‑range context, memory, web)
- 🧠 **Long‑term memory**: Can store facts when a user explicitly says “remember …”
- 🧩 **Hierarchical chat summaries**: Every 200 messages → a summary; 200 summaries → higher‑level summaries
- 🖼️ **Image understanding**: Analyzes photos/documents and stores concise visual context
- 🎙️ **Media context**: Transcribes voice/audio/video/circle videos locally with Whisper and samples video frames for visual context
- 📝 **Full message persistence**: Saves all messages (text and media), with edit history
- 🎭 **Reactions tracking**: Tracks emoji and custom emoji reactions with add/remove deltas
- 👥 **User tracking**: Maintains user profiles and updates on changes
- 🎯 **Smart triggering**: Responds only when mentioned (`@bot`) or when you reply to the bot
- 🌐 **On‑demand web access**: Can fetch fresh info only when asked
- 📱 **Group‑only operation**: Works in group chats; private `/start` for info only
- 🚀 **Webhook & polling**: Choose between webhook server or polling
- 🛡️ **Security & reliability**: Webhook secret validation, retries, throttling, structured logging

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Bot framework**: grammY + `hydrate`, `parse-mode`, `auto-retry`, `throttler`, Mongo session storage
- **Database**: MongoDB (messages, users, memories, summaries)
- **Local media processing**: `faster-whisper` + `ffmpeg` in Docker for transcripts and video frame extraction
- **AI (OpenRouter)**:
  - Reply: `openai/gpt-5.5`
  - Agent/router: `openai/gpt-5.5`
  - Summarization & Vision: `openai/gpt-5.4-mini`
  - Web search: self-hosted SearXNG
- **Server**: Hono (Node) for webhook endpoints
- **Logging**: Pino

## Setup

### 1. Environment Variables

Create `.env` with:

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_API_KEY=your_bot_api_key_here
TELEGRAM_BOT_MODE=polling  # or 'webhook'
TELEGRAM_BOT_WEBHOOK_URL=https://your-domain.com/webhook  # if using webhook
TELEGRAM_BOT_WEBHOOK_SECRET=your_webhook_secret_here      # if using webhook
TELEGRAM_BOT_SERVER_HOST=0.0.0.0
TELEGRAM_BOT_SERVER_PORT=3000
TELEGRAM_BOT_ADMIN_IDS=123456789,987654321               # comma-separated numeric user IDs

# OpenRouter AI Configuration
OPENROUTER_API_KEY=sk_your_openrouter_api_key_here

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/groknul-bot-db

# Optional local media processing overrides
WHISPER_MODEL=base
MEDIA_MAX_VIDEO_FRAMES=10
MEDIA_MAX_TRANSCRIPT_CHARS=8000
MEDIA_DOWNLOAD_TIMEOUT_MS=60000
WHISPER_TIMEOUT_MS=120000
FFMPEG_TIMEOUT_MS=60000
```

### 2. Installation

```bash
npm install
```

### 3. Build

```bash
npm run build
```

### 4. Run

```bash
npm start
```

For development:

```bash
npm run dev
```

## Usage

### Bot Setup

1. Create a new bot via [@BotFather](https://t.me/BotFather)
2. Add the bot to your group chat
3. Grant permissions to read messages
4. Mention the bot or reply to its message to trigger a response

### Commands

- `/start` — Show bot info (private chat only)

Admin‑only (run in private chat with the bot, users in `TELEGRAM_BOT_ADMIN_IDS`):

- `/stats` — Show aggregate DB stats (total messages, chats, top chats)
- `/say <chatId> <text>` — Send a message to a chat by Telegram chat ID
- `/reply <dbMessageId> <text>` — Reply in a chat to a specific DB‑stored message

### Triggering Responses

The bot will respond when:

- You mention it directly: `@your_bot_username what do you think?`
- You reply to one of the bot’s messages

### Features in Action

1. **Message storage**: All messages are saved with metadata (type, file name, edits, replies, forwards)
2. **Media context**: Photos are summarized; voice/audio/video/circle videos are transcribed locally; videos also contribute up to 10 sampled frames for visual summaries
3. **Reactions tracking**: Adds/removes (including custom emoji) are recorded per user
4. **Long‑range context**: The last ~200 messages are used for quick replies; background summaries provide older context; persistent memories store explicit facts
5. **Routing**: A fast model decides whether to save memory, use long‑range summaries, or enable web access (only when asked)
6. **Responses**: AI replies are saved back to DB; tool usage is optionally announced in‑chat

## API Endpoints (Webhook Mode)

- `GET /` — Basic API information
- `GET /health` — Health check endpoint
- `POST /webhook` — Telegram webhook endpoint (validates secret token)

## Deployment

### Using Polling Mode

Set `TELEGRAM_BOT_MODE=polling` and run the bot. No additional server setup required. Polling uses `@grammyjs/runner` so different chats can process concurrently; updates inside the same chat stay sequential to keep session state safe. A long voice/video transcription can therefore delay later updates in that chat while other chats keep moving.

### Using Webhook Mode

1. Set `TELEGRAM_BOT_MODE=webhook`
2. Configure `TELEGRAM_BOT_WEBHOOK_URL` with your public HTTPS URL
3. Set `TELEGRAM_BOT_WEBHOOK_SECRET` for request verification
4. Deploy where inbound HTTPS is available
5. The bot configures the webhook at startup

### Local Media Processing

The Docker image installs `ffmpeg` and a CPU `faster-whisper` environment, then preloads `WHISPER_MODEL` during the image build. At runtime each transcribable media message runs one Python Whisper subprocess. This keeps deployment simple for low-volume group chats; high-volume deployments should replace it with a persistent transcription worker or queue.
