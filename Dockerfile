# 部落冲突 联赛统一报名系统 —— 通用 Docker 镜像
# 零第三方依赖，直接使用 Node 内置 node:sqlite（要求 Node >= 22.5）
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/app.db

WORKDIR /app

# 仅需后端与前端两个文件，无需 npm install
COPY package.json ./
COPY server.js index.html ./

# 数据目录（首次启动自动建库并写入种子名单）
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "server.js"]
