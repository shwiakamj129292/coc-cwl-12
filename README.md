# COC CWL 报名系统

使用 Cloudflare Workers Static Assets + Worker Modules + D1。页面和报名 API 共用一个 `workers.dev` 链接；D1 在服务端持久保存报名数据，不需要付费持久磁盘。Tailwind CSS 与 Font Awesome 在构建时打包为本站静态资源，不依赖第三方 CDN。

## Workers Git 部署

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages → D1 SQL Database**，新建数据库 `coc-cwl-signup`。
2. 打开新数据库的 **Console**，将 [初始化 SQL](migrations/0001_init.sql) 全部内容粘贴并执行一次。它会导入 7 个部落和 44 条旧报名。
3. 进入 **Workers & Pages → Create application → Connect to Git**，选择本仓库和要部署的分支，使用 Workers Builds（不是 Pages）。
4. 构建设置使用 `npm run build`，部署命令使用 `npx wrangler deploy`。预览构建也使用 `npm run build`；仓库中的 `wrangler.jsonc` 会提供 Worker 入口、静态资源和 D1 绑定配置，输出目录为 `dist`。
5. D1 绑定由 `wrangler.jsonc` 的 `d1_databases` 统一声明（绑定名 `DB`、数据库名 `coc-cwl-signup`）。部署前请把其中的 `database_id` 改成第 1 步新建数据库显示的 ID；`npx wrangler deploy` 会自动带上该绑定，**无需**在 Dashboard 的 **Settings → Bindings** 再手动添加。
6. 在 **Settings → Variables and Secrets** 添加 Secret `ADMIN_PASSWORD`，设置强管理员密码。该 Secret 优先于数据库中的旧密码哈希，配置后即可用它登录管理员。代码不再包含默认管理员密码；务必在分享网站前配置此 Secret。若使用 Secret，改密需在 Cloudflare 控制台更新 Secret。首次初始化若不设置 `ADMIN_PASSWORD`，必须先设置一次性 `ADMIN_SETUP_TOKEN` Secret；没有它时公开初始化接口会拒绝设置密码。
7. 打开 Cloudflare 提供的 `https://<项目名>.<子域名>.workers.dev`，这是分享给群友的报名链接。

不要重复执行初始化 SQL，否则会因主键重复而报错。

Cloudflare 免费 D1 单库上限为 500 MB，足够当前名单规模；免费计划也有请求额度，超额后需要等待额度重置或升级。详见 [D1 官方限制](https://developers.cloudflare.com/d1/platform/limits/)。

## 存储容量检测与自动清理（升级须知）

本版本新增了「存储容量」能力：管理员面板里会出现 **存储容量** 按钮，随时查看已用 / 服务器额度；
面板会**逐表列出全部数据的占用**（报名记录、审计日志、历史归档、设备令牌、管理员会话、登录尝试、限流记录、部落配置、系统设置），
使用率超过 50% 时系统会**自动从最旧记录开始清理**（3 个月内的记录永不删除），并在面板里告知"删了多少条、最早删到什么时候"，
同时会检测异常的大数据使用（如短时间内大量报名 / 日志）并提醒管理员。
每次清理还会顺带删除**已过期的管理员会话**与过期限流记录，避免这些临时表长期无界增长（过期即失效、即删，不影响正常登录与报名）。

升级时请按顺序执行尚未运行的迁移：

1. [migrations/0002_storage_and_limits.sql](migrations/0002_storage_and_limits.sql)：创建 `device_tokens`（设备令牌签发登记）与 `rate_limits`（报名 / 取令牌的 IP 限速）并回填旧报名已绑定令牌。
2. [migrations/0003_redact_admin_session_logs.sql](migrations/0003_redact_admin_session_logs.sql)：清除历史操作日志中可能保存的管理员会话令牌。

可在 D1 控制台 **Console** 粘贴 SQL 执行，或运行：

```sh
npx wrangler d1 execute coc-cwl-signup --remote --file=migrations/0002_storage_and_limits.sql
npx wrangler d1 execute coc-cwl-signup --remote --file=migrations/0003_redact_admin_session_logs.sql
```

这两项迁移都只需对目标远程数据库执行一次；执行前建议先备份 D1。**未执行 `0002` 时，令牌登记与 IP 限流会降级放行**，因此不要把代码中的限流视为已生效，直到确认迁移完成。

定时清理依赖 `wrangler.jsonc` 中的 Cron Triggers（默认每 6 小时一次），`npx wrangler deploy` 会自动生效。
容量额度默认取服务器（Cloudflare D1）给你的 500 MB，可在管理员面板「存储容量」里改成你实际拿到的额度，
或用 Secret / 变量 `STORAGE_LIMIT_BYTES` 覆盖（单位：字节）。


本地预览可执行 `npm run preview`。未配置本地 D1 时只能确认静态页面；API smoke 需先在 Wrangler 本地配置 D1 绑定。`npm run build` 会编译 Tailwind 并把 Font Awesome CSS/字体复制到 `dist`，部署不再依赖外部样式 CDN。

Docker 首次部署必须在 `.env` 或环境中提供强 `ADMIN_PASSWORD`，不再提供默认密码。Cloudflare 自定义域名需在你的 Cloudflare 账号中绑定并配置 DNS；代码仓库无法替代账号权限完成此步骤。

## 重要

- GitHub 仓库页和 GitHub Pages 不是报名链接；必须使用 Cloudflare Worker 部署后生成的 `workers.dev` 地址。
- Cloudflare 账号需要授权 GitHub 仓库，并由你创建 D1 数据库、设置管理员密码；这些账号凭证不能由代码代替。
- 不要把管理员密码写入仓库或公开发给群友。
