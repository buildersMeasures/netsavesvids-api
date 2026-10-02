FROM node:22-bookworm-slim

# Install Python, FFmpeg and required packages
RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp
RUN pip3 install --break-system-packages --no-cache-dir -U yt-dlp

# Application directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --omit=dev

# Copy application
COPY server.js ./

# Render uses the PORT environment variable
EXPOSE 10000

# Start server
CMD ["node", "server.js"]
