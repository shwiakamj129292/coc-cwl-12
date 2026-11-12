# COC CWL 报名系统

使用 Cloudflare Workers Static Assets + Worker Modules + D1。页面和报名 API 共用一个 `workers.dev` 链接；D1 在服务端持久保存报名数据，不需要付费持久磁盘。

## Workers Git 部署

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages → D1 SQL Database**，新建数据库 `coc-cwl-signup`。
2. 打开新数据库的 **Console**，将 [初始化 SQL](migrations/0001_init.sql) 全部内容粘贴并执行一次。它会导入 7 个部落和 44 条旧报名。
3. 进入 **Workers & Pages → Create application → Connect to Git**，选择本仓库和要部署的分支，使用 Workers Builds（不是 Pages）。
4. 构建设置使用 `npm run build`，部署命令使用 `npx wrangler deploy`。预览构建也使用 `npm run build`；仓库中的 `wrangler.jsonc` 会提供 Worker 入口和静态资源配置，输出目录为 `dist`。
5. 创建 Worker 后，进入 **Settings → Bindings → Add → D1 database**，变量名填 `DB` 并选择 `coc-cwl-signup`。Wrangler 配置故意不包含数据库 ID，绑定由 Dashboard 管理。
6. 在 **Settings → Variables and Secrets** 添加 Secret `ADMIN_PASSWORD`，设置强管理员密码。绑定和 Secret 配置完成后，API 即可使用。
7. 打开 Cloudflare 提供的 `https://<项目名>.<子域名>.workers.dev`，这是分享给群友的报名链接。

不要重复执行初始化 SQL，否则会因主键重复而报错。

Cloudflare 免费 D1 单库上限为 500 MB，足够当前名单规模；免费计划也有请求额度，超额后需要等待额度重置或升级。详见 [D1 官方限制](https://developers.cloudflare.com/d1/platform/limits/)。

本地预览可执行 `npm run preview`。未配置本地 D1 时只能确认静态页面；API smoke 需先在 Wrangler 本地配置 D1 绑定。`npm run build` 只将 `index.html` 复制到 `dist`，作为唯一公开的静态资源。

## 重要

- GitHub 仓库页和 GitHub Pages 不是报名链接；必须使用 Cloudflare Worker 部署后生成的 `workers.dev` 地址。
- Cloudflare 账号需要授权 GitHub 仓库，并由你创建 D1 数据库、设置管理员密码；这些账号凭证不能由代码代替。
- 不要把管理员密码写入仓库或公开发给群友。
