# COC CWL Signup

报名系统由 Node.js 后端和 SQLite 数据库组成。GitHub Pages 只能托管静态文件，不能运行报名 API 或写入数据库；请使用支持 Node.js 和持久化磁盘的服务托管。

## 在 Render 部署

1. 在 Render 选择 **New +** -> **Blueprint**，连接本 GitHub 仓库并选择 `main` 分支。
2. Render 读取仓库根目录的 `render.yaml`，创建 Node Web Service 和 `/data` 持久化磁盘。
3. 按提示设置 `ADMIN_PASSWORD` 为强密码，然后部署。
4. 打开 Render 提供的 `https://...onrender.com` 服务网址。请使用这个网址报名，不要使用 GitHub 仓库源码页或 GitHub Pages 链接。

Render 上的持久化磁盘需要付费服务计划。不要删除或重新创建磁盘，否则其中的报名数据库会丢失。

## 本地运行

需要 Node.js 22.5 或更高版本。

```sh
ADMIN_PASSWORD='replace-with-a-strong-password' npm start
```

浏览器打开 `http://localhost:3000`。本地数据库默认路径为 `data/app.db`；部署时请把 `DB_FILE` 指向可写的持久化磁盘。
