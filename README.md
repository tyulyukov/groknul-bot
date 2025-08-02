# Groknul Bot

A sophisticated Telegram bot that observes group conversations, saves all messages (including edit history) to MongoDB, and generates AI-powered responses using OpenRouter's API when mentioned or replied to.

## Features

- 🤖 **AI-Powered Responses**: Uses Gemini 2.0 Flash Lite via OpenRouter for intelligent conversation
- 📝 **Message Persistence**: Saves all group messages to MongoDB with complete edit history
- 👥 **User Tracking**: Maintains user profiles with historical changes (username, name changes)
- 🎯 **Smart Triggering**: Responds only when mentioned (@bot) or when users reply to bot messages
- 🔄 **Edit Tracking**: Tracks all message edits with version history
- 📱 **Group-Only Operation**: Works exclusively in group chats, not DMs (except /start command)
- 🚀 **Webhook & Polling Support**: Supports both webhook and polling modes
- 🛡️ **Security**: Webhook secret verification and comprehensive error handling
- 📊 **Logging**: Structured logging with Pino for monitoring and debugging

## Tech Stack

- **Runtime**: Node.js 18+ with TypeScript
- **Bot Framework**: Grammy with multiple plugins
- **Database**: MongoDB for message and user storage
- **AI**: OpenRouter API with Gemini 2.0 Flash Lite
- **Server**: Hono for webhook handling
- **Logging**: Pino with pretty printing

## Architecture

The project follows SOLID principles with a modular, feature-based structure:

```
src/
├── common/           # Shared utilities (config, logger)
├── database/         # MongoDB models and connection
│   └── models/       # TelegramUser and Message models
├── services/         # Business logic services
│   ├── AIService.ts     # OpenRouter integration
│   └── TelegramBotService.ts  # Main bot logic
├── server/           # Webhook server
└── app.ts           # Application entry point
```

## Setup

### 1. Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_API_KEY=your_bot_api_key_here
TELEGRAM_BOT_MODE=polling  # or 'webhook'
TELEGRAM_BOT_WEBHOOK_URL=https://your-domain.com  # if using webhook
TELEGRAM_BOT_WEBHOOK_SECRET=your_webhook_secret_here  # if using webhook
TELEGRAM_BOT_SERVER_HOST=0.0.0.0
TELEGRAM_BOT_SERVER_PORT=3000

# OpenRouter AI Configuration
OPENROUTER_API_KEY=your_openrouter_api_key_here

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/groknul-bot
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
4. **Context-Aware AI**: Bot uses the last 500 messages as context for responses
5. **Smart Responses**: AI generates relevant responses based on conversation context

## Database Schema

### TelegramUser Collection
```typescript
{
  telegramId: number,        // Unique Telegram user ID
  username?: string,         // Current username
  firstName?: string,        // Current first name
  lastName?: string,         // Current last name
  isBot: boolean,           // Whether user is a bot
  isPremium?: boolean,      // Telegram Premium status
  languageCode?: string,    // User's language
  history: [{              // Historical changes
    username?: string,
    firstName?: string,
    lastName?: string,
    timestamp: Date
  }],
  createdAt: Date,
  updatedAt: Date
}
```

### Message Collection
```typescript
{
  messageId: number,         // Telegram message ID
  chatId: number,           // Telegram chat ID
  userId: number,           // Reference to TelegramUser
  text?: string,            // Message text
  replyToMessageId?: number, // If replying to another message
  date: Date,               // Original send date
  editDate?: Date,          // Last edit date
  edits: [{                // Edit history
    text?: string,
    editedAt: Date,
    version: number
  }],
  messageType: string,      // 'text', 'photo', 'video', etc.
  forwardFromChatId?: number,
  forwardFromMessageId?: number,
  isDeleted: boolean,
  createdAt: Date,
  updatedAt: Date
}
```

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

## Development

### Project Structure
- **SOLID Principles**: Clear separation of concerns
- **DRY**: Reusable components and utilities
- **Feature-based**: Organized by functionality, not file type
- **Type Safety**: Full TypeScript coverage
- **Error Handling**: Comprehensive error handling and logging

### Key Components

- **AIService**: Handles OpenRouter API communication and context building
- **TelegramBotService**: Main bot logic, message handling, and user interaction
- **Database Models**: MongoDB integration with proper indexing
- **WebhookServer**: Hono-based server for webhook handling
- **Configuration**: Environment-based configuration with validation

## Contributing

1. Follow the existing code style and architecture
2. Add proper TypeScript types
3. Include error handling and logging
4. Test thoroughly before submitting

## License

This project is private and proprietary. 