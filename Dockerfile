FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno for yt-dlp JavaScript support
RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL=/root/.deno
ENV PATH=/root/.deno/bin:$PATH

# Install yt-dlp with all default optional dependencies.
# curl_cffi provides browser impersonation support used by TikTok.
RUN pip3 install --break-system-packages --no-cache-dir -U "yt-dlp[default]"

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY server.js ./

EXPOSE 10000

CMD ["node", "server.js"]
