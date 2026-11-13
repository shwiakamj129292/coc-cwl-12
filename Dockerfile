# 部落冲突联赛报名系统：构建时编译本站 CSS 并复制图标资源。
FROM node:24-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html ./
COPY styles ./styles
COPY scripts ./scripts
COPY tailwind.config.cjs ./
RUN npm run build

FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/app.db

WORKDIR /app

COPY server.js ./
COPY --from=build /app/dist ./dist

# 数据目录（首次启动自动建库并写入种子名单）
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "server.js"]
