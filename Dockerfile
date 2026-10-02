FROM node:22-bookworm-slim

# ----------------------------------------
# System packages
# ----------------------------------------

RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------
# Install Deno
# ----------------------------------------

RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL="/root/.deno"
ENV PATH="/root/.deno/bin:$PATH"

# ----------------------------------------
# Install yt-dlp + EJS + PO Token provider
# ----------------------------------------

RUN python3 -m pip install \
    --break-system-packages \
    --no-cache-dir \
    -U \
    "yt-dlp[default]" \
    bgutil-ytdlp-pot-provider

# ----------------------------------------
# Application
# ----------------------------------------

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY server.js ./

# ----------------------------------------
# Start
# ----------------------------------------

EXPOSE 10000

CMD ["node", "server.js"]
