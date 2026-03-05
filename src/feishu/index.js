const { Client, WSClient, EventDispatcher, LoggerLevel } = require('@larksuiteoapi/node-sdk');
const { callClaudeStream } = require('../claude');
const { logger, createLogger } = require('../logger');

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

/**
 * Create Feishu Bot using SDK's WSClient
 */
function createBot(appId, appSecret) {
  let client = null;
  let wsClient = null;

  /**
   * Extract text content from message
   */
  function extractTextContent(event) {
    // SDK might use message_type or msg_type
    const msgType = event.msg_type || event.message_type;
    const content = event.content || '';

    logger.info({ msgType, content, event }, 'Message info');

    if (msgType === 'text') {
      try {
        const parsed = JSON.parse(content);
        logger.info({ parsed }, 'Parsed content');
        return parsed.text || '';
      } catch (e) {
        logger.error({ error: e.message }, 'Parse error');
        return content;
      }
    }

    return '';
  }

  /**
   * Reply to message
   */
  async function replyMessage(receiveId, receiveIdType, content) {
    try {
      await client.im.message.create({
        params: {
          receive_id_type: receiveIdType
        },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: content })
        }
      });
    } catch (error) {
      logger.error({ error: error.message, receiveId }, 'Failed to reply message');
    }
  }

  /**
   * Process message with Claude
   */
  async function processMessage(data) {
    const event = data.message;
    const messageId = event.message_id;
    const chatId = event.chat_id;
    const text = extractTextContent(event);
    const log = createLogger({ chatId, messageId });

    log.info({ text: text?.substring(0, 50), msgType: event.msg_type }, 'Received message');

    if (!text || !text.trim()) {
      log.info('Empty message, skipping');
      return;
    }

    // Skip bot's own messages
    if (event.sender?.sender_type === 'app') {
      log.info('Skipping bot own message');
      return;
    }

    let currentResponse = '';
    let toolMessages = [];

    try {
      // Send initial response
      await replyMessage(chatId, 'chat_id', '⏳ 正在思考...');

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

      await callClaudeStream(text,
        async (chunk) => {
          currentResponse += chunk;
        },
        handleToolUse,
        chatId
      );

      // Send tool usage summary
      if (toolMessages.length > 0) {
        const toolCount = toolMessages.filter(m => m.type === 'tool_use').length;
        await replyMessage(chatId, 'chat_id', `🔧 共使用了 ${toolCount} 个工具`);
      }

      // Send final response
      if (currentResponse) {
        if (currentResponse.length <= 4000) {
          await replyMessage(chatId, 'chat_id', currentResponse);
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
            await replyMessage(chatId, 'chat_id', chunk);
          }
        }
      }
    } catch (error) {
      log.error({ error: error.message, stack: error.stack }, 'Error processing message');
      await replyMessage(chatId, 'chat_id', `抱歉，遇到错误: ${error.message}`);
    }
  }

  /**
   * Start the bot
   */
  function start() {
    logger.info('Starting Feishu Bot with SDK...');

    // Create client for sending messages
    client = new Client({
      appId,
      appSecret,
      loggerLevel: LoggerLevel.error
    });

    // Create event dispatcher and register message handler
    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        logger.info({ data }, 'Received event data');
        await processMessage(data);
      }
    });

    // Create WSClient
    wsClient = new WSClient({
      appId,
      appSecret,
      loggerLevel: LoggerLevel.debug
    });

    // Start connection with event dispatcher
    wsClient.start({ eventDispatcher });

    return {
      stop: () => {
        if (wsClient) {
          wsClient.close();
        }
      }
    };
  }

  return { start };
}

module.exports = { createBot };
