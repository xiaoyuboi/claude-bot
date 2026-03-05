require('dotenv').config();
const { createBot } = require('./bot/telegram');
const { logger } = require('./logger');

// Check for bot token
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  logger.error('TELEGRAM_BOT_TOKEN is not set in .env file');
  process.exit(1);
}

logger.info('Starting Claude Telegram Bot...');

// Create and start the bot
const bot = createBot(token);

logger.info('Bot is running. Send a message to your bot on Telegram!');

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down bot...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down bot...');
  bot.stopPolling();
  process.exit(0);
});
