// coc-cwl 别名代理 Worker
// 作用：把所有请求透明转发到真实站点 coc-cwl-12.arnold2003XXXX.workers.dev
// 浏览器地址栏始终显示 coc-cwl.<账户子域名>.workers.dev，不暴露真实网址
//
// 部署命令（需安装 wrangler 并登录 Cloudflare）：
//   npx wrangler deploy --config alias/wrangler.jsonc

const REAL_ORIGIN = "https://coc-cwl-12.arnold2003XXXX.workers.dev";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 构建转发到真实站点的 URL（保留路径和查询参数）
    const upstreamUrl = REAL_ORIGIN + url.pathname + url.search;

    // 转发请求（保留方法、头、body）
    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });

    const response = await fetch(upstreamRequest);

    // 返回响应（保持状态码和头，地址栏不会跳转）
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};
