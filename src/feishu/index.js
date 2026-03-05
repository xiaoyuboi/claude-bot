const axios = require('axios');
const WebSocket = require('ws');
const { callClaudeStream } = require('../claude');
const { logger, createLogger } = require('../logger');

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry wrapper
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
 * Create Feishu Bot instance
 */
function createBot(appId, appSecret) {
  let ws = null;
  let tenantAccessToken = null;
  let tokenExpireTime = 0;
  let heartbeatInterval = null;

  /**
   * Get tenant access token
   */
  async function getTenantAccessToken() {
    const now = Date.now();
    if (tenantAccessToken && now < tokenExpireTime - 60000) {
      return tenantAccessToken;
    }

    const response = await axios.post(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      app_id: appId,
      app_secret: appSecret
    });

    if (response.data.code !== 0) {
      throw new Error(`Failed to get token: ${response.data.msg}`);
    }

    tenantAccessToken = response.data.tenant_access_token;
    tokenExpireTime = now + response.data.expire * 1000;
    logger.info({ expire: response.data.expire }, 'Got tenant access token');

    return tenantAccessToken;
  }

  /**
   * Send message to Feishu
   */
  async function sendMessage(receiveId, receiveIdType, content, msgType = 'text') {
    const token = await getTenantAccessToken();

    const response = await axios.post(`${FEISHU_API_BASE}/im/v1/messages`, {
      receive_id: receiveId,
      receive_id_type: receiveIdType,
      msg_type: msgType,
      content: JSON.stringify({ text: content })
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.code !== 0) {
      throw new Error(`Failed to send message: ${response.data.msg}`);
    }

    return response.data;
  }

  /**
   * Reply to message
   */
  async function replyMessage(messageId, content, msgType = 'text') {
    const token = await getTenantAccessToken();

    const response = await axios.post(`${FEISHU_API_BASE}/im/v1/messages/${messageId}/reply`, {
      msg_type: msgType,
      content: JSON.stringify({ text: content })
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.code !== 0) {
      throw new Error(`Failed to reply message: ${response.data.msg}`);
    }

    return response.data;
  }

  /**
   * Get WebSocket URL for card callback
   */
  async function getWebSocketUrl() {
    const token = await getTenantAccessToken();

    const response = await axios.post(`${FEISHU_API_BASE}/im/v1/warmup/websocket`, {}, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.code !== 0) {
      throw new Error(`Failed to get WebSocket URL: ${response.data.msg}`);
    }

    return response.data.data.wss_url;
  }

  /**
   * Extract text content from message
   */
  function extractTextContent(message) {
    const msgType = message.message?.msg_type;

    if (msgType === 'text') {
      return message.message?.body?.content || '';
    }

    if (msgType === 'post') {
      // Handle post messages
      const post = message.message?.body?.content;
      if (post && post.post && post.post.chinese) {
        // Get first text content from post
        const content = post.post.chinese;
        if (content && content.length > 0) {
          return content[0]?.text || '';
        }
      }
    }

    if (msgType === 'at' && message.message?.body?.content) {
      try {
        const content = JSON.parse(message.message.body.content);
        return content?.text || '';
      } catch (e) {
        return '';
      }
    }

    return '';
  }

  /**
   * Process message with Claude
   */
  async function processMessage(message, reply) {
    const messageId = message.message?.message_id;
    const chatId = message.message?.chat_id || message.message?.sender?.chat_id;
    const text = extractTextContent(message);
    const log = createLogger({ chatId, messageId });

    log.info({ text: text?.substring(0, 50), msgType: message.message?.msg_type }, 'Received message');

    if (!text || !text.trim()) {
      log.info('Empty message, skipping');
      return;
    }

    let currentResponse = '';
    let toolMessages = [];

    try {
      // Send initial response
      await reply('⏳ 正在思考...');

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

      let lastUpdateTime = 0;
      const updateReply = async (newText) => {
        const now = Date.now();
        if (now - lastUpdateTime >= 1000) {
          lastUpdateTime = now;
          try {
            await reply(newText.substring(0, 4000));
          } catch (e) {
            logger.warn({ error: e.message }, 'Failed to update reply');
          }
        }
      };

      await withRetry(async () => {
        await callClaudeStream(text,
          async (chunk) => {
            currentResponse += chunk;
            await updateReply(currentResponse);
          },
          handleToolUse,
          chatId
        );
      });

      // Send tool usage summary
      if (toolMessages.length > 0) {
        const toolCount = toolMessages.filter(m => m.type === 'tool_use').length;
        await reply(`🔧 共使用了 ${toolCount} 个工具`);
      }

      // Send final response
      if (currentResponse) {
        if (currentResponse.length <= 4000) {
          await reply(currentResponse);
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
            await reply(chunk);
          }
        }
      }
    } catch (error) {
      log.error({ error: error.message, stack: error.stack }, 'Error processing message');
      await reply(`抱歉，遇到错误: ${error.message}`);
    }
  }

  /**
   * Connect to WebSocket
   */
  async function connect() {
    try {
      const wssUrl = await getWebSocketUrl();
      logger.info({ wssUrl }, 'Connecting to Feishu WebSocket');

      ws = new WebSocket(wssUrl);

      ws.on('open', () => {
        logger.info('WebSocket connected');
      });

      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          logger.debug({ message }, 'Received WebSocket message');

          // Handle ping
          if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }

          // Handle challenge (for verification)
          if (message.type === 'url_verification') {
            ws.send(JSON.stringify({
              type: 'url_verification',
              challenge: message.challenge
            }));
            return;
          }

          // Handle event callback
          if (message.type === 'event_callback') {
            const event = message.event;

            // Handle message events
            if (event.msg_type) {
              const chatId = event.chat_id;
              const messageId = event.message_id;
              const log = createLogger({ chatId, messageId });

              // Skip bot's own messages
              if (event.sender?.sender_type === 'app') {
                log.info('Skipping bot own message');
                return;
              }

              // Process the message
              await processMessage({ message: event }, async (content) => {
                await replyMessage(messageId, content);
              });
            }
          }
        } catch (error) {
          logger.error({ error: error.message }, 'Error processing WebSocket message');
        }
      });

      ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason?.toString() }, 'WebSocket closed');
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        // Reconnect after delay
        setTimeout(() => {
          logger.info('Reconnecting...');
          connect();
        }, 5000);
      });

      ws.on('error', (error) => {
        logger.error({ error: error.message }, 'WebSocket error');
      });

      // Send heartbeat
      heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to connect to WebSocket');
      // Retry after delay
      setTimeout(() => {
        logger.info('Retrying connection...');
        connect();
      }, 5000);
    }
  }

  /**
   * Start the bot
   */
  function start() {
    logger.info('Starting Feishu Bot...');
    connect();
    return {
      stop: () => {
        if (ws) {
          ws.close();
        }
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
      }
    };
  }

  return { start };
}

module.exports = { createBot };
