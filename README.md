# COC CWL 报名系统

使用 Cloudflare Pages + Pages Functions + D1。页面和报名 API 共用一个 `pages.dev` 链接；D1 在服务端持久保存报名数据，不需要付费持久磁盘。

## 免费部署

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages → D1 SQL Database**，新建数据库 `coc-cwl-signup`。
2. 打开新数据库的 **Console**，将 [初始化 SQL](migrations/0001_init.sql) 全部内容粘贴并执行一次。它会导入 7 个部落和 44 条旧报名。
3. 在 Cloudflare 选择 **Workers & Pages → Create application → Pages → Connect to Git**，连接本仓库的 `main` 分支。Framework preset 选 `None`，Build command 填 `npm run build`，Build output directory 填 `dist`。
4. 在 Pages 项目的 **Settings → Functions → D1 database bindings** 添加绑定：Variable name 填 `DB`，数据库选 `coc-cwl-signup`。
5. 在 Pages 项目的 **Settings → Variables and Secrets** 添加 Secret `ADMIN_PASSWORD`，设置强管理员密码，然后重新部署。
6. 部署成功后，打开 Cloudflare 提供的 `https://<项目名>.pages.dev`。这个就是分享给群友的报名链接。

不要重复执行初始化 SQL，否则会因主键重复而报错。

Cloudflare 免费 D1 单库上限为 500 MB，足够当前名单规模；免费计划也有请求额度，超额后需要等待额度重置或升级。详见 [D1 官方限制](https://developers.cloudflare.com/d1/platform/limits/)。

## 重要

- GitHub 仓库页和 GitHub Pages 不是报名链接；必须使用 Cloudflare Pages 部署后生成的 `pages.dev` 地址。
- Cloudflare 账号需要授权 GitHub 仓库，并由你创建 D1 数据库、设置管理员密码；这些账号凭证不能由代码代替。
- 不要把管理员密码写入仓库或公开发给群友。
