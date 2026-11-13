import { onRequest } from "./functions/api/[[path]].js";

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
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};
