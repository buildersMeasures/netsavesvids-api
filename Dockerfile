FROM node:22-bookworm-slim

# ----------------------------------------
# Install system packages
# ----------------------------------------

RUN apt-get update && \
    apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------
# Install Deno
# Deno is recommended by yt-dlp for
# YouTube JavaScript challenge solving
# ----------------------------------------

RUN curl -fsSL https://deno.land/install.sh | sh

ENV DENO_INSTALL="/root/.deno"
ENV PATH="/root/.deno/bin:$PATH"

# ----------------------------------------
# Install yt-dlp with EJS support
# ----------------------------------------

RUN pip3 install \
    --break-system-packages \
    --no-cache-dir \
    -U \
    "yt-dlp[default]"

# ----------------------------------------
# Application directory
# ----------------------------------------

WORKDIR /app

# ----------------------------------------
# Copy Node package files
# ----------------------------------------

COPY package*.json ./

# ----------------------------------------
# Install Node dependencies
# ----------------------------------------

RUN npm install --omit=dev

# ----------------------------------------
# Copy application
# ----------------------------------------

COPY server.js ./

# ----------------------------------------
# Render port
# ----------------------------------------

EXPOSE 10000

# ----------------------------------------
# Start application
# ----------------------------------------

CMD ["node", "server.js"]
