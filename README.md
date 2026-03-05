# Claude Bot

基于 Claude Code 的多平台聊天机器人，支持 Telegram 和飞书。

## 功能特性

- 🤖 **多平台支持** - 同时支持 Telegram 和飞书
- 🧠 **上下文记忆** - 支持多轮对话，会话持久化
- 🔌 **WebSocket 长连接** - 飞书使用 WebSocket 模式（无需公网回调）
- 💬 **Claude Code 集成** - 直接调用本地 Claude Code，支持工具调用

## 支持的平台

| 平台 | 连接方式 | 说明 |
|------|---------|------|
| Telegram | Polling | 需要 Bot Token |
| 飞书 | WebSocket | 需要 App ID 和 App Secret |

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/xiaoyuboi/claude-bot.git
cd claude-bot
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env` 并配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# Telegram Bot Token (从 @BotFather 获取)
TELEGRAM_BOT_TOKEN=your_bot_token

# 飞书机器人凭据 (从 https://open.feishu.cn/app 获取)
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

### 4. 启动机器人

```bash
pnpm start
```

### 5. 开机自启动 (Mac)

```bash
# 复制启动配置
cp com.claude-bot.plist ~/Library/LaunchAgents/

# 加载服务
launchctl load ~/Library/LaunchAgents/com.claude-bot.plist
```

## 飞书机器人配置

### 1. 创建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 创建「企业内部应用」
3. 获取 App ID 和 App Secret

### 2. 添加权限

在「权限管理」中添加：
- `im:message` - 接收消息
- `im:message:send_as_bot` - 发消息
- `im:chat` - 群聊管理

### 3. 开启长连接

1. 进入「事件与回调」
2. 订阅方式选择「使用长连接接收事件」
3. 添加事件 `im.message.receive_v1`
4. 发布应用

### 4. 创建机器人

1. 进入「机器人」
2. 创建机器人
3. 在飞书中搜索机器人账号并添加

## 使用方法

### Telegram

1. 搜索机器人 `@your_bot_username`
2. 发送消息开始对话
3. 使用 `/clear` 清除会话

### 飞书

1. 私聊机器人账号
2. 群聊中 @机器人
3. 发送消息开始对话

## 项目结构

```
claude-bot/
├── src/
│   ├── index.js          # 入口文件
│   ├── claude.js         # Claude 调用逻辑
│   ├── logger.js         # 日志模块
│   ├── bot/
│   │   └── telegram.js   # Telegram 机器人
│   └── feishu/
│       └── index.js       # 飞书机器人
├── sessions.json         # 会话持久化
├── bot.log              # 运行日志
└── docker-compose.yml   # Docker 配置
```

## Docker 部署

```bash
docker compose up -d
```

## 技术栈

- Node.js
- Telegram Bot API
- 飞书开放平台 API (@larksuiteoapi/node-sdk)
- Claude Code

## 许可证

MIT
