require('dotenv').config();
const { createBot: createTelegramBot } = require('./bot/telegram');
const { createBot: createFeishuBot } = require('./feishu');
const { logger } = require('./logger');

// Check for Telegram bot token
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

// Check for Feishu credentials
const feishuAppId = process.env.FEISHU_APP_ID;
const feishuAppSecret = process.env.FEISHU_APP_SECRET;

const bots = [];

if (telegramToken) {
  logger.info('Starting Telegram Bot...');
  const telegramBot = createTelegramBot(telegramToken);
  bots.push({ name: 'Telegram', stop: () => telegramBot.stopPolling() });
} else {
  logger.warn('TELEGRAM_BOT_TOKEN is not set in .env file, Telegram bot will not start');
}

if (feishuAppId && feishuAppSecret) {
  // Use WebSocket mode
  logger.info('Starting Feishu Bot (WebSocket mode)...');
  const feishuBot = createFeishuBot(feishuAppId, feishuAppSecret);
  const feishuHandle = feishuBot.start();
  bots.push({ name: 'Feishu', stop: () => feishuHandle.stop() });
} else {
  logger.warn('FEISHU_APP_ID or FEISHU_APP_SECRET is not set in .env file, Feishu bot will not start');
}

if (bots.length === 0) {
  logger.error('No bots configured. Please set at least one bot token in .env file');
  process.exit(1);
}

logger.info({ bots: bots.map(b => b.name) }, 'All bots are running');

// Handle graceful shutdown
const shutdown = (signal) => {
  logger.info(`Received ${signal}, shutting down bots...`);
  for (const bot of bots) {
    logger.info(`Stopping ${bot.name} bot...`);
    bot.stop();
  }
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
