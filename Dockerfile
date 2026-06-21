FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/web/package.json apps/web/package.json

RUN npm ci

COPY apps/server apps/server
COPY apps/web apps/web

RUN npm run build --workspace @giada/server
RUN npm run build --workspace @giada/web

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    ffmpeg \
    python3 \
    python3-pip \
  && python3 -m pip install --break-system-packages --no-cache-dir -U "yt-dlp[default]" bgutil-ytdlp-pot-provider \
  && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
  && command -v deno \
  && deno --version \
  && command -v yt-dlp \
  && yt-dlp --version \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["node", "apps/server/dist/src/index.js"]
