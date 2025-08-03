# Groknul Bot

A sophisticated Telegram bot that observes group conversations, saves all messages (including edit history) and reactions to MongoDB, and generates AI-powered responses using OpenRouter's API when mentioned or replied to.
The inspiration comes from Twitter's Grok that is deeply integrated into tweets. The bot is named after it, "groknul", which sounds similar to "grohnul" (rus. грохнул) can be translated to 'crashed' or 'banged' from Russian, adding a playful and whimsical twist to the name.


## Features

- 🤖 **AI-Powered Responses**: Uses gpt-4.1-mini via OpenRouter for intelligent conversation
- 📝 **Message Persistence**: Saves all group messages to MongoDB with complete edit history
- 👥 **User Tracking**: Maintains user profiles with historical changes (username, name changes)
- 🎯 **Smart Triggering**: Responds only when mentioned (@bot) or when users reply to bot messages
- 🔄 **Edit Tracking**: Tracks all message edits with version history
- ❤️ **Reactions Tracking**: Tracks all reactions to messages
- 📱 **Group-Only Operation**: Works exclusively in group chats, not DMs (except /start command)
- 🚀 **Webhook & Polling Support**: Supports both webhook and polling modes
- 🛡️ **Security**: Webhook secret verification and comprehensive error handling
- 📊 **Logging**: Structured logging with Pino for monitoring and debugging

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Bot Framework**: Grammy with multiple plugins
- **Database**: MongoDB for message and user storage
- **AI**: OpenRouter API with gpt-4.1-mini
- **Server**: Hono for webhook handling
- **Logging**: Pino with pretty printing

## Setup

### 1. Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_API_KEY=your_bot_api_key_here
TELEGRAM_BOT_MODE=polling  # or 'webhook'
TELEGRAM_BOT_WEBHOOK_URL=https://your-domain.com/webhook  # if using webhook
TELEGRAM_BOT_WEBHOOK_SECRET=your_webhook_secret_here  # if using webhook
TELEGRAM_BOT_SERVER_HOST=0.0.0.0
TELEGRAM_BOT_SERVER_PORT=3000

# OpenRouter AI Configuration
OPENROUTER_API_KEY=sk_your_openrouter_api_key_here

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/groknul-bot-db
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

1. Create a new bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Add the bot to your group chat
3. Make sure the bot has permission to read all messages
4. Start using the bot by mentioning it or replying to its messages

### Commands

- `/start` - Shows bot information (only works in private chats)

### Triggering Responses

The bot will respond when:
- Someone mentions it directly: `@your_bot_username what do you think?`
- Someone replies to one of the bot's messages

### Features in Action

1. **Message Storage**: Every message in the group is automatically saved to MongoDB
2. **User Tracking**: User profiles are created/updated when they send messages
3. **Edit History**: When someone edits a message, the original is preserved
4. **Reactions Tracking**: When someone reacts to a message, it is automatically saved to MongoDB
5. **Context-Aware AI**: Bot uses the last 200 messages as context for responses
6. **Smart Responses**: AI generates relevant responses based on conversation context

## API Endpoints (Webhook Mode)

- `GET /` - Basic API information
- `GET /health` - Health check endpoint
- `POST /webhook` - Telegram webhook endpoint

## Deployment

### Using Polling Mode
Set `TELEGRAM_BOT_MODE=polling` and run the bot. No additional server setup required.

### Using Webhook Mode
1. Set `TELEGRAM_BOT_MODE=webhook`
2. Configure `TELEGRAM_BOT_WEBHOOK_URL` with your public domain
3. Set `TELEGRAM_BOT_WEBHOOK_SECRET` for security
4. Deploy to a server with HTTPS support
5. The bot will automatically configure the webhook with Telegram
