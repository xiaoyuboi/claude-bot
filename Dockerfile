FROM node:18-bullseye

WORKDIR /app

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash appuser

# Copy source code
COPY src/ ./src/
COPY .env.example .env

# Use non-root user
USER appuser

CMD ["node", "src/index.js"]
