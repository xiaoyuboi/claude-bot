const TelegramBot = require('node-telegram-bot-api');
const { callClaudeStream } = require('../claude');
const { logger, createLogger } = require('../logger');

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      logger.warn({ attempt: i + 1, error: error.message }, 'Retry attempt failed');
      if (i < maxRetries - 1) {
        const delay = RETRY_DELAY * (i + 1);
        logger.info({ delay }, 'Retrying...');
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Create and configure a Telegram bot
 */
function createBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const log = createLogger({ chatId, messageId: msg.message_id });

    log.info({ text: text?.substring(0, 50) }, 'Received message');

    if (!text || text.startsWith('/')) {
      return;
    }

    if (text === '/clear') {
      await bot.sendMessage(chatId, '会话已清除，请发送新消息开始新对话。');
      return;
    }

    bot.sendChatAction(chatId, 'typing');

    let sentMessage = null;
    let currentResponse = '';
    let lastUpdateTime = 0;
    let typingInterval = null;
    let toolMessages = [];

    try {
      // Send without parse_mode to avoid Markdown issues
      sentMessage = await bot.sendMessage(chatId, '⏳ 正在思考...');

      typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, 'typing');
      }, 3000);

      const handleToolUse = (type, data) => {
        if (type === 'tool_use') {
          const toolName = data.name || 'Unknown';
          const inputStr = JSON.stringify(data.input, null, 2);
          const truncated = inputStr.length > 300 ? inputStr.substring(0, 300) + '...' : inputStr;
          toolMessages.push({ type: 'tool_use', name: toolName, input: truncated });
        } else if (type === 'tool_result') {
          const content = typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2);
          const truncated = content.length > 800 ? content.substring(0, 800) + '\n\n...（结果过长）' : content;
          toolMessages.push({ type: 'tool_result', content: truncated });
        }
      };

      await withRetry(async () => {
        await callClaudeStream(text,
          async (chunk) => {
            currentResponse += chunk;

            const now = Date.now();
            const shouldUpdate = now - lastUpdateTime >= 500;

            if (shouldUpdate) {
              lastUpdateTime = now;

              if (currentResponse.length > 4000) {
                try {
                  await bot.sendMessage(chatId, currentResponse);
                } catch (e) {}
                currentResponse = '';
              } else if (sentMessage) {
                try {
                  await bot.editMessageText(currentResponse, {
                    chat_id: chatId,
                    message_id: sentMessage.message_id
                  });
                } catch (e) {}
              }
            }
          },
          handleToolUse,
          chatId
        );
      });

      if (typingInterval) clearInterval(typingInterval);

      try {
        await bot.deleteMessage(chatId, sentMessage.message_id);
      } catch (e) {}

      if (toolMessages.length > 0) {
        const toolCount = toolMessages.filter(m => m.type === 'tool_use').length;
        await bot.sendMessage(chatId, `🔧 共使用了 ${toolCount} 个工具`);
      }

      let toolSummary = '';
      for (const tm of toolMessages) {
        if (tm.type === 'tool_use') {
          toolSummary += `\n🔧 ${tm.name}:\n${tm.input}\n`;
        } else {
          toolSummary += `\n📤 结果:\n${tm.content}\n`;
        }
      }

      if (toolSummary) {
        await bot.sendMessage(chatId, `▎🔽 工具调用详情\n${toolSummary}`);
      }

      if (currentResponse) {
        if (currentResponse.length <= 4096) {
          try {
            await bot.sendMessage(chatId, currentResponse);
          } catch (e) {}
        } else {
          const chunks = [];
          let currentChunk = '';
          const maxLength = 4000;

          for (const line of currentResponse.split('\n')) {
            if ((currentChunk + line + '\n').length > maxLength) {
              if (currentChunk) chunks.push(currentChunk.trim());
              currentChunk = line + '\n';
            } else {
              currentChunk += line + '\n';
            }
          }
          if (currentChunk) chunks.push(currentChunk.trim());

          for (const chunk of chunks) {
            await bot.sendMessage(chatId, chunk);
          }
        }
      }
    } catch (error) {
      log.error({ error: error.message, stack: error.stack }, 'Error processing message');
      if (typingInterval) clearInterval(typingInterval);

      const errorMessage = `抱歉，遇到错误: ${error.message}`;
      if (sentMessage) {
        try {
          await bot.editMessageText(errorMessage, {
            chat_id: chatId,
            message_id: sentMessage.message_id
          });
        } catch (e) {
          await bot.sendMessage(chatId, errorMessage);
        }
      } else {
        await bot.sendMessage(chatId, errorMessage);
      }
    }
  });

  bot.on('polling_error', (error) => {
    logger.error({ error: error.message }, 'Polling error');
  });

  return bot;
}

module.exports = { createBot };
