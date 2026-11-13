import { onRequest, runMaintenance } from "./functions/api/[[path]].js";

// 主页（HTML）安全响应头。
// 说明：页面依赖 cdn.tailwindcss.com（运行期注入样式）与 cdnjs 的 Font Awesome，
// 且使用了内联脚本与 onclick 内联事件，因此 script-src/style-src 必须放开 'unsafe-inline'
// 与这两个 CDN；同时用 frame-ancestors 'none' / X-Frame-Options 防点击劫持、
// object-src 'none' 与 base-uri 'self' 收紧其余面。
const HTML_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "font-src 'self' data: https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'"
].join("; ");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return onRequest({ request, env });
    }

    // 所有非 API 请求统一返回 index.html（SPA）。
    // HTML 必须始终取最新版，禁止浏览器/CDN 缓存——
    // 否则每次部署后用户仍会看到旧页面（旧标签、旧脚本），直到缓存过期。
    const assetUrl = new URL("/index.html", url);
    const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
    headers.set("Content-Security-Policy", HTML_CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  },

  // Cron Triggers 定时触发：检查容量，超过 50% 时从最旧记录清理（3 个月内不动）。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  }
};
