# COC CWL 报名系统

使用 Cloudflare Workers Static Assets + Worker Modules + D1。页面和报名 API 共用一个 `workers.dev` 链接；D1 在服务端持久保存报名数据，不需要付费持久磁盘。Tailwind CSS 与 Font Awesome 在构建时打包为本站静态资源，不依赖第三方 CDN。

## Workers Git 部署

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages → D1 SQL Database**，新建数据库 `coc-cwl-signup`。
2. 打开新数据库的 **Console**，将 [初始化 SQL](migrations/0001_init.sql) 全部内容粘贴并执行一次。它会建立表结构并写入一份示例名单。
3. 进入 **Workers & Pages → Create application → Connect to Git**，选择本仓库和要部署的分支，使用 Workers Builds（不是 Pages）。
4. 构建设置使用 `npm run build`，部署命令使用 `npx wrangler deploy`。预览构建也用 `npm run build`；仓库中的 `wrangler.jsonc` 会提供 Worker 入口、静态资源和 D1 绑定配置，输出目录为 `dist`。
5. 把 `wrangler.jsonc` 里的 `database_id` 改成第 1 步新建数据库显示的 ID，`npx wrangler deploy` 会自动带上该绑定，**无需**在 Dashboard 的 **Settings → Bindings** 再手动添加。
6. 在 **Settings → Variables and Secrets** 添加 Secret `ADMIN_PASSWORD`，设置一个强管理员密码，即可用它登录管理员。
7. 打开 Cloudflare 提供的 `https://<项目名>.<子域名>.workers.dev`，这是分享给群友的报名链接。

不要重复执行初始化 SQL，否则会因主键重复而报错。

Cloudflare 免费 D1 单库上限为 500 MB，足够当前名单规模；免费计划也有请求额度，超额后需要等待额度重置或升级。详见 [D1 官方限制](https://developers.cloudflare.com/d1/platform/limits/)。

## 本地预览与 Docker

本地预览可执行 `npm run preview`。未配置本地 D1 时只能确认静态页面；API smoke 需先在 Wrangler 本地配置 D1 绑定。`npm run build` 会编译 Tailwind 并把 Font Awesome CSS/字体复制到 `dist`，部署不再依赖外部样式 CDN。

Docker 首次部署必须在 `.env` 或环境中提供强 `ADMIN_PASSWORD`，不再提供默认密码。Cloudflare 自定义域名需在你的 Cloudflare 账号中绑定并配置 DNS；代码仓库无法替代账号权限完成此步骤。

## 数据与容量

管理员面板里会出现 **存储容量** 按钮，随时查看已用 / 服务器额度，并逐表列出各表数据的占用；容量紧张时系统会自动清理较旧的记录，近期记录会被保留。可用变量 `STORAGE_LIMIT_BYTES` 覆盖默认额度（单位：字节）。升级时请按 `migrations/` 目录顺序执行尚未运行的迁移。

## 重要

- GitHub 仓库页和 GitHub Pages 不是报名链接；必须使用 Cloudflare Worker 部署后生成的 `workers.dev` 地址。
- Cloudflare 账号需要授权 GitHub 仓库，并由你创建 D1 数据库、设置管理员密码；这些账号凭证不能由代码代替。
- 不要把你的管理员密码或任何 Secret 写入仓库，也不要公开发给群友。
- 仓库内 migrations 的初始名单是示例数据，部署后请按需替换为你自己的实际名单。
