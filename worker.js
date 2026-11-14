import { onRequest, runMaintenance } from "./functions/api/[[path]].js";

// 主页（HTML）安全响应头。
// 页面样式和图标均由本站静态资源提供；内联脚本与 onclick 仍需要 unsafe-inline。
// 同时用 frame-ancestors 'none' / X-Frame-Options 防点击劫持、
// object-src 'none' 与 base-uri 'self' 收紧其余面。
const HTML_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'"
].join("; ");

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return onRequest({ request, env });
    }

    // Serve built CSS/fonts directly; route page paths to the SPA entry.
    // Keep the HTML uncached so deployments take effect immediately.
    const assetPath = url.pathname === "/" || !url.pathname.includes(".")
      ? "/index.html"
      : url.pathname;
    const assetUrl = new URL(assetPath, url);
    const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
    headers.set("Content-Security-Policy", HTML_CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Strict-Transport-Security", "max-age=31536000");
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
