const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

// Session file path
const SESSION_FILE = path.join(__dirname, '..', 'sessions.json');

// Session management - store session IDs per chat
const sessions = new Map();

/**
 * Load sessions from file
 */
function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, 'utf8').trim();
      if (data) {
        const loaded = JSON.parse(data);
        for (const [chatId, sessionId] of Object.entries(loaded)) {
          sessions.set(chatId, sessionId);
        }
        logger.info({ count: sessions.size }, 'Loaded sessions from file');
      }
    }
  } catch (e) {
    logger.error({ error: e.message }, 'Failed to load sessions');
  }
}

/**
 * Save sessions to file
 */
function saveSessions() {
  try {
    const data = {};
    for (const [chatId, sessionId] of sessions) {
      data[chatId] = sessionId;
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error({ error: e.message }, 'Failed to save sessions');
  }
}

// Load sessions on startup
loadSessions();

/**
 * Get or create a session for a chat
 */
function getSession(chatId) {
  return sessions.get(chatId) || null;
}

function setSession(chatId, sessionId) {
  sessions.set(chatId, sessionId);
  logger.info({ chatId, sessionId }, 'Session set');
  saveSessions();
}

/**
 * Call Claude Code CLI with streaming support
 */
function callClaudeStream(prompt, onChunk, onToolUse, chatId) {
  return new Promise((resolve, reject) => {
    const sessionId = getSession(chatId);
    logger.info({ chatId, sessionId }, 'Calling Claude');

    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--verbose'
    ];

    // Continue existing session if available
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const claude = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env,
      cwd: '/tmp'
    });

    let buffer = '';
    let fullResponse = '';
    let stderr = '';
    let currentToolUse = null;
    let currentSessionId = sessionId;

    claude.stdout.on('data', (data) => {
      buffer += data.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);

          // Capture session ID from top-level field
          if (!currentSessionId && parsed.session_id) {
            currentSessionId = parsed.session_id;
            if (chatId) setSession(chatId, currentSessionId);
            logger.info({ sessionId: currentSessionId }, 'Captured session');
          }

          const event = parsed.event;

          // Handle text delta
          if (event?.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              fullResponse += delta.text;
              if (onChunk) onChunk(delta.text);
            }
          }

          // Handle tool use start
          if (event?.type === 'content_block_start') {
            const contentBlock = event.content_block;
            if (contentBlock?.type === 'tool_use') {
              currentToolUse = {
                name: contentBlock.name,
                input: ''
              };
            }
          }

          // Handle tool input delta
          if (event?.type === 'content_block_delta') {
            const delta = event.delta;
            if (delta?.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.input += delta.partial_json;
            }
          }

          // Handle tool use stop
          if (event?.type === 'content_block_stop' && currentToolUse) {
            try {
              currentToolUse.input = JSON.parse(currentToolUse.input);
            } catch (e) {}
            if (onToolUse) onToolUse('tool_use', currentToolUse);
            currentToolUse = null;
          }
        } catch (e) {
          // Check for user message with tool result
          if (line.includes('"type":"user"') && line.includes('"tool_result"')) {
            try {
              const parsed = JSON.parse(line);
              const toolResult = parsed.message?.content?.[0];
              if (toolResult && onToolUse) {
                onToolUse('tool_result', toolResult);
              }
            } catch (e) {}
          }
        }
      }
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          if (parsed.event?.type === 'content_block_delta') {
            const delta = parsed.event.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              fullResponse += delta.text;
              if (onChunk) onChunk(delta.text);
            }
          }
        } catch (e) {}
      }

      if (code === 0 || fullResponse) {
        resolve(fullResponse);
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      }
    });

    claude.on('error', (err) => {
      reject(err);
    });

    claude.stdin.write(prompt);
    claude.stdin.end();
  });
}

module.exports = { callClaudeStream, getSession, setSession };
