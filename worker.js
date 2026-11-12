import { onRequest } from "./functions/api/[[path]].js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return onRequest({ request, env });
    }

    const assetUrl = new URL("/index.html", url);
    return env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
  }
};
