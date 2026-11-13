const ADMIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const PASSWORD_HASH_ITERATIONS = 210000;
const DEFAULT_ADMIN_PASSWORD = "";
const MAX_BODY = 64 * 1024;
const ALLOWED_TH = new Set(["", "19本", "18本", "17本", "16本", "15本及以下"]);
const VALID_COLORS = new Set([
  "rose", "orange", "amber", "emerald", "cyan",
  "sky", "indigo", "purple", "pink", "slate"
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Resource-Policy": "same-origin"
    }
  });
}

function stmt(db, sql, ...values) {
  return db.prepare(sql).bind(...values);
}

async function first(db, sql, ...values) {
  return stmt(db, sql, ...values).first();
}

async function all(db, sql, ...values) {
  const result = await stmt(db, sql, ...values).all();
  return result.results || [];
}

async function batch(db, statements) {
  return db.batch(statements);
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY) throw new HttpError(413, "body too large");
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new HttpError(413, "body too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid json");
  }

  if (!size) return {};
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON body must be an object");
    }
    return value;
  } catch {
    throw new HttpError(400, "invalid json");
  }
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function deviceToken(request) {
  const value = request.headers.get("x-device-token") || "";
  return /^#U-[A-Z0-9]{4,32}$/.test(value) ? value : null;
}

async function adminToken(request, db) {
  const match = /^Bearer (.+)$/.exec(request.headers.get("authorization") || "");
  if (!match) return null;
  const row = await first(db, "SELECT expires_at FROM sessions WHERE token = ?", match[1]);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await stmt(db, "DELETE FROM sessions WHERE token = ?").bind(match[1]).run();
    return null;
  }
  return match[1];
}

function passwordMatches(candidate, configured) {
  if (typeof configured !== "string" || !configured) return false;
  const left = new TextEncoder().encode(candidate);
  const right = new TextEncoder().encode(configured);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (left[i] || 0) ^ (right[i] || 0);
  }
  return difference === 0;
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g), byte => parseInt(byte, 16));
}

async function hashAdminPassword(password, saltHex, iterations = PASSWORD_HASH_ITERATIONS) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  if (!salt) throw new Error("invalid password salt");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return `${iterations}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyAdminPassword(password, encoded) {
  const [iterationText, saltHex, expectedHex, extra] = String(encoded || "").split("$");
  const iterations = Number(iterationText);
  const expected = hexToBytes(expectedHex || "");
  if (extra !== undefined || !Number.isInteger(iterations) ||
      iterations < 100000 || iterations > 1000000 || !expected) {
    return false;
  }
  const actualHex = (await hashAdminPassword(password, saltHex, iterations)).split("$")[2];
  return passwordMatches(actualHex, expectedHex);
}

async function recordLoginAttempt(db, request, now) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  await stmt(db, "DELETE FROM login_attempts WHERE window_start <= ?")
    .bind(now - LOGIN_WINDOW_MS).run();
  const attempt = await first(
    db,
    `INSERT INTO login_attempts(ip, window_start, count) VALUES(?, ?, 1)
     ON CONFLICT(ip) DO UPDATE SET
       window_start = CASE WHEN login_attempts.window_start <= ? THEN excluded.window_start ELSE login_attempts.window_start END,
       count = CASE WHEN login_attempts.window_start <= ? THEN 1 ELSE login_attempts.count + 1 END
     RETURNING count`,
    ip, now, now - LOGIN_WINDOW_MS, now - LOGIN_WINDOW_MS
  );
  return attempt?.count || 1;
}

async function adminPasswordConfigured(db, env) {
  if (typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD) return true;
  return !!(await first(db, "SELECT value FROM settings WHERE key = 'adminPasswordHash'"));
}

// Resolve the currently effective admin password in priority order:
//   env.ADMIN_PASSWORD (Secret) > DB adminPasswordHash > built-in DEFAULT.
// The default always works so a fresh deployment is never locked out.
async function verifyCurrentAdminPassword(db, env, candidate) {
  const configuredPassword = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
  if (configuredPassword) return passwordMatches(candidate, configuredPassword);
  const storedHash = await first(db, "SELECT value FROM settings WHERE key = 'adminPasswordHash'");
  if (storedHash) return verifyAdminPassword(candidate, storedHash.value);
  return passwordMatches(candidate, DEFAULT_ADMIN_PASSWORD);
}

function setupTokenRequired(db, env) {
  const envSetupToken = typeof env.ADMIN_SETUP_TOKEN === "string" ? env.ADMIN_SETUP_TOKEN : "";
  return { envSetupToken, required: !!envSetupToken };
}

async function setupAdminPassword(request, env) {
  const db = env.DB;
  if (await recordLoginAttempt(db, request, Date.now()) > 8) {
    return json({ error: "尝试次数过多，请稍后再试" }, 429);
  }
  if (await adminPasswordConfigured(db, env)) {
    return json({ error: "管理员密码已初始化" }, 409);
  }

  const body = await readJson(request);
  const password = String(body.password || "");
  if (password.length < 12 || password.length > 128) {
    return json({ error: "密码需为 12 至 128 个字符" }, 400);
  }

  // A setup token is only required when one has been explicitly configured
  // (env ADMIN_SETUP_TOKEN, or a row in settings). Otherwise the very first
  // setup call bootstraps the admin password without a token — this mirrors
  // the common first-run bootstrap pattern used by self-hosted apps, so a
  // misconfigured Cloudflare secret does not lock the admin out entirely.
  const { envSetupToken, required } = setupTokenRequired(db, env);
  const setupTokenRow = required
    ? null
    : await first(db, "SELECT value FROM settings WHERE key = 'admin_setup_token'");
  const tokenRequired = required || !!setupTokenRow;

  let token = "";
  if (tokenRequired) {
    token = String(body.token || "");
    if (!/^[0-9a-f]{64}$/i.test(token)) {
      return json({ error: "一次性授权码无效" }, 403);
    }
    const expected = required ? envSetupToken : (setupTokenRow ? setupTokenRow.value : "");
    if (!expected || !passwordMatches(token, expected)) {
      return json({ error: "一次性授权码无效或已使用" }, 403);
    }
  }

  const encoded = await hashAdminPassword(password);
  const where = tokenRequired
    ? `WHERE (EXISTS (SELECT 1 FROM settings WHERE key = 'admin_setup_token' AND value = ?)
          OR ? <> '')
       AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'adminPasswordHash')`
    : `WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'adminPasswordHash')`;
  const inserted = await first(
    db,
    `INSERT INTO settings(key, value)
     SELECT 'adminPasswordHash', ?
     ${where}
     RETURNING key`,
    ...(tokenRequired ? [encoded, token, envSetupToken] : [encoded])
  );
  if (!inserted) {
    return json({ error: tokenRequired ? "一次性授权码无效或已使用" : "管理员密码已初始化" }, 409);
  }
  if (tokenRequired && !required) {
    await stmt(db, "DELETE FROM settings WHERE key = 'admin_setup_token' AND value = ?")
      .bind(token).run();
  }
  const sessionToken = randomHex(24);
  const expiresAt = Date.now() + ADMIN_SESSION_MS;
  await stmt(db, "INSERT INTO sessions(token, created_at, expires_at) VALUES(?, ?, ?)")
    .bind(sessionToken, Date.now(), expiresAt).run();
  return json({ ok: true, adminToken: sessionToken, expiresAt });
}

function logStatement(db, type, clan, details, operator, token, time = Date.now()) {
  return stmt(
    db,
    "INSERT INTO logs(time, type, clan, details, operator, token) " +
      "SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0",
    time, type, clan, details, operator || "群友", token || "未知签名"
  );
}

function revStatement(db) {
  return stmt(
    db,
    "UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'rev' AND changes() > 0"
  );
}

async function saveChange(db, change, log) {
  const results = await batch(db, [change, log, revStatement(db)]);
  return results[0]?.meta?.changes || 0;
}

async function buildState(db, request) {
  const token = await adminToken(request, db);
  const device = deviceToken(request);
  const [settings, clanRows, entryRows] = await Promise.all([
    all(db, "SELECT key, value FROM settings WHERE key IN ('mainTitle', 'subTitle', 'rankOptions', 'rev')"),
    all(db, "SELECT * FROM clans ORDER BY sort ASC"),
    all(db, "SELECT * FROM entries ORDER BY created_at ASC, id ASC")
  ]);
  const setting = Object.fromEntries(settings.map(row => [row.key, row.value]));
  const byClan = new Map();
  for (const entry of entryRows) {
    if (!byClan.has(entry.clan_id)) byClan.set(entry.clan_id, []);
    byClan.get(entry.clan_id).push(entry);
  }

  function presentEntry(entry) {
    const value = { id: entry.id, text: entry.name };
    if (token || entry.owner_token === "#SYS_PRESET" || (device && entry.owner_token === device)) {
      value.ownerToken = token ? entry.owner_token : entry.owner_token === "#SYS_PRESET" ? "#SYS_PRESET" : device;
    }
    return value;
  }

  return {
    rev: Number.parseInt(setting.rev || "0", 10),
    meta: { mainTitle: setting.mainTitle || "", subTitle: setting.subTitle || "" },
    rankOptions: JSON.parse(setting.rankOptions || "[]"),
    clans: clanRows.map(clan => {
      const entries = byClan.get(clan.id) || [];
      return {
        id: clan.id,
        name: clan.name,
        tag: clan.tag,
        rank: clan.rank,
        category: clan.category,
        capacity: clan.capacity,
        time: clan.time,
        requirement: clan.requirement,
        players: entries.filter(entry => entry.role === "main").map(presentEntry),
        subs: entries.filter(entry => entry.role !== "main").map(presentEntry)
      };
    })
  };
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid path");
  }
}

async function login(request, env) {
  const db = env.DB;
  const now = Date.now();
  if (await recordLoginAttempt(db, request, now) > 8) {
    return json({ error: "尝试次数过多，请稍后再试" }, 429);
  }

  const body = await readJson(request);
  const candidate = String(body.password || "");
  if (candidate.length > 128) return json({ error: "密码错误" }, 401);
  if (!(await verifyCurrentAdminPassword(db, env, candidate))) {
    return json({ error: "密码错误" }, 401);
  }
  const token = randomHex(24);
  const expiresAt = now + ADMIN_SESSION_MS;
  await stmt(db, "INSERT INTO sessions(token, created_at, expires_at) VALUES(?, ?, ?)")
    .bind(token, now, expiresAt).run();
  return json({ adminToken: token, expiresAt });
}

async function changeAdminPassword(request, env) {
  const db = env.DB;
  const token = await adminToken(request, db);
  if (!token) return json({ error: "需要管理员权限" }, 403);

  const body = await readJson(request);
  const oldPassword = String(body.oldPassword || "");
  const newPassword = String(body.newPassword || "");
  if (newPassword.length < 12 || newPassword.length > 128) {
    return json({ error: "新密码需为 12 至 128 个字符" }, 400);
  }
  if (newPassword === DEFAULT_ADMIN_PASSWORD) {
    return json({ error: "新密码不能使用系统默认密码" }, 400);
  }
  if (!(await verifyCurrentAdminPassword(db, env, oldPassword))) {
    return json({ error: "当前密码不正确" }, 401);
  }

  const encoded = await hashAdminPassword(newPassword);
  await stmt(db, "INSERT INTO settings(key, value) VALUES('adminPasswordHash', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(encoded).run();
  // Force other sessions to re-login with the new password.
  await stmt(db, "DELETE FROM sessions WHERE token <> ?").bind(token).run();
  return json({ ok: true });
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const db = env.DB;

  if (path === "/api/device") {
    if (method !== "POST") return json({ error: "method" }, 405);
    return json({ deviceToken: `#U-${randomHex(8).toUpperCase()}` });
  }

  if (path === "/api/admin/setup/status") {
    if (method !== "GET") return json({ error: "method" }, 405);
    const { envSetupToken, required } = setupTokenRequired(db, env);
    const setupTokenRow = required
      ? null
      : await first(db, "SELECT value FROM settings WHERE key = 'admin_setup_token'");
    const tokenRequired = required || !!setupTokenRow;
    const configured = await adminPasswordConfigured(db, env);
    return json({
      available: !configured,
      tokenRequired
    });
  }

  if (path === "/api/admin/setup") {
    if (method !== "POST") return json({ error: "method" }, 405);
    return setupAdminPassword(request, env);
  }

  if (path === "/api/admin/login") {
    if (method !== "POST") return json({ error: "method" }, 405);
    return login(request, env);
  }

  if (path === "/api/admin/check") {
    if (method !== "GET") return json({ error: "method" }, 405);
    return json({ ok: !!(await adminToken(request, db)) });
  }

  if (path === "/api/admin/logout") {
    if (method !== "POST") return json({ error: "method" }, 405);
    const token = await adminToken(request, db);
    if (token) await stmt(db, "DELETE FROM sessions WHERE token = ?").bind(token).run();
    return json({ ok: true });
  }

  if (path === "/api/admin/password") {
    if (method !== "PUT") return json({ error: "method" }, 405);
    return changeAdminPassword(request, env);
  }

  // 管理员诊断接口：返回所有报名的原始归属信息，用于排查"绑定数据丢失"问题
  if (path === "/api/admin/diagnose") {
    if (method !== "GET") return json({ error: "method" }, 405);
    const token = await adminToken(request, db);
    if (!token) return json({ error: "需要管理员权限" }, 403);
    const entries = await all(db, `
      SELECT e.id, e.clan_id, c.name AS clan_name, e.role, e.name, e.owner_token, e.created_at
      FROM entries e LEFT JOIN clans c ON e.clan_id = c.id
      ORDER BY e.created_at ASC
    `);
    const presetCount = entries.filter(e => e.owner_token === "#SYS_PRESET").length;
    const realCount = entries.filter(e => e.owner_token && e.owner_token !== "#SYS_PRESET").length;
    const unknownCount = entries.filter(e => !e.owner_token).length;
    const uniqueTokens = new Set(entries.map(e => e.owner_token).filter(t => t && t !== "#SYS_PRESET"));
    return json({
      total: entries.length,
      preset: presetCount,
      real: realCount,
      unknown: unknownCount,
      uniqueUsers: uniqueTokens.size,
      entries: entries.map(e => ({
        id: e.id, clan: e.clan_name || e.clan_id, role: e.role,
        name: e.name, ownerToken: e.owner_token || null,
        createdAt: new Date(e.created_at).toLocaleString("zh-CN", { hour12: false })
      }))
    });
  }

  if (path === "/api/state") {
    if (method !== "GET") return json({ error: "method" }, 405);
    const currentRev = Number.parseInt((await first(db, "SELECT value FROM settings WHERE key = 'rev'"))?.value || "0", 10);
    const clientRev = url.searchParams.get("rev");
    if (clientRev !== null && Number.parseInt(clientRev, 10) === currentRev) {
      return json({ rev: currentRev, unchanged: true });
    }
    return json(await buildState(db, request));
  }

  if (path === "/api/signup") {
    if (method !== "POST") return json({ error: "method" }, 405);
    const actor = deviceToken(request);
    if (!actor) return json({ error: "缺少或非法的设备令牌" }, 400);
    const body = await readJson(request);
    const clanId = String(body.clanId || "");
    const clan = await first(db, "SELECT id, name, capacity FROM clans WHERE id = ?", clanId);
    if (!clan) return json({ error: "部落不存在" }, 404);
    const role = body.role === "sub" ? "sub" : "main";
    const th = ALLOWED_TH.has(body.th) ? body.th : "";
    const name = String(body.name || "").trim().slice(0, 40);
    if (!name) return json({ error: "昵称不能为空" }, 400);
    const text = th ? `${name} ${th}` : name;
    const entryId = `e_${randomHex(8)}`;
    const now = Date.now();
    const results = await batch(db, [
      stmt(
        db,
        `INSERT INTO entries(id, clan_id, role, name, owner_token, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE ? = 'sub' OR
           (SELECT COUNT(*) FROM entries WHERE clan_id = ? AND role = 'main') <
           (SELECT capacity FROM clans WHERE id = ?)`,
        entryId, clan.id, role, text, actor, now, role, clan.id, clan.id
      ),
      stmt(
        db,
        "INSERT INTO logs(time, type, clan, details, operator, token) " +
          "SELECT ?, 'ADD', ?, ?, ?, ? WHERE changes() > 0",
        now, clan.name, `新增【${role === "sub" ? "替补" : "正选"}】：${text}`, name, actor
      ),
      revStatement(db)
    ]);
    if (!(results[0]?.meta?.changes > 0)) {
      return json({ error: "full", message: "正选名额已满，请改报替补" }, 409);
    }
    return json({ ok: true, entryId });
  }

  const entryMatch = /^\/api\/entries\/([^/]+)(\/move)?$/.exec(path);
  if (entryMatch) {
    const entryId = decodePathPart(entryMatch[1]);
    const isMove = !!entryMatch[2];
    const entry = await first(db, "SELECT * FROM entries WHERE id = ?", entryId);
    if (!entry) return json({ error: "报名不存在" }, 404);
    const clan = await first(db, "SELECT * FROM clans WHERE id = ?", entry.clan_id);
    if (!clan) return json({ error: "部落不存在" }, 404);
    const admin = await adminToken(request, db);
    const device = deviceToken(request);

    if (isMove) {
      if (method !== "POST") return json({ error: "method" }, 405);
      if (!admin) return json({ error: "需要管理员权限" }, 403);
      const body = await readJson(request);
      const toSub = body.direction === "toSub";
      const nextRole = toSub ? "sub" : "main";
      const results = await batch(db, [
        stmt(
          db,
          `UPDATE entries SET role = ? WHERE id = ? AND
             (? = 'sub' OR role = 'main' OR
              (SELECT COUNT(*) FROM entries WHERE clan_id = ? AND role = 'main') <
              (SELECT capacity FROM clans WHERE id = ?))`,
          nextRole, entryId, nextRole, entry.clan_id, entry.clan_id
        ),
        logStatement(db, "EDIT", clan.name, `${toSub ? "转为替补" : "升为正选"}：${entry.name}`, "管理员", admin),
        revStatement(db)
      ]);
      if (!(results[0]?.meta?.changes > 0)) {
        const current = await first(db, "SELECT role FROM entries WHERE id = ?", entryId);
        if (!current) return json({ error: "报名不存在" }, 404);
        const count = await first(
          db,
          "SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = 'main'",
          entry.clan_id
        );
        if (!toSub && current.role !== "main" && count.n >= clan.capacity) {
          return json({ error: "正选已满，无法升为正选" }, 409);
        }
        return json({ error: "报名不存在" }, 404);
      }
      return json({ ok: true });
    }

    const isOwner = !!device && entry.owner_token === device;
    const canClaim = !admin && !!device && entry.owner_token === "#SYS_PRESET";
    if (!admin && !isOwner && !canClaim) return json({ error: "无权操作该报名" }, 403);

    if (method === "PATCH") {
      const body = await readJson(request);
      const th = ALLOWED_TH.has(body.th) ? body.th : "";
      const name = String(body.name || "").trim().slice(0, 40);
      if (!name) return json({ error: "昵称不能为空" }, 400);
      const newText = body.th && th ? `${name} ${th}` : name;
      const where = admin
        ? "id = ?"
        : canClaim
          ? "id = ? AND owner_token = '#SYS_PRESET'"
          : "id = ? AND owner_token = ?";
      const result = await saveChange(
        db,
        stmt(db, `UPDATE entries SET name = ?, owner_token = ? WHERE ${where}`, ...(
          admin ? [newText, entry.owner_token, entryId] :
            canClaim ? [newText, device, entryId] : [newText, entry.owner_token, entryId, device]
        )),
        logStatement(db, "EDIT", clan.name, `修改报名：${entry.name} ➔ ${newText}`, name, admin || device)
      );
      if (!result) {
        return json({ error: "无权操作该报名" }, 403);
      }
      return json({ ok: true });
    }

    if (method === "DELETE") {
      const condition = admin
        ? "id = ?"
        : canClaim
          ? "id = ? AND owner_token = '#SYS_PRESET'"
          : "id = ? AND owner_token = ?";
      const args = admin ? [entryId] : canClaim ? [entryId] : [entryId, device];
      const result = await saveChange(
        db,
        stmt(db, `DELETE FROM entries WHERE ${condition}`, ...args),
        logStatement(db, "REMOVE", clan.name, `移除/退赛：${entry.name}`, admin ? "管理员" : entry.name, admin || device)
      );
      if (!result) return json({ error: "无权操作该报名" }, 403);
      return json({ ok: true });
    }

    return json({ error: "method" }, 405);
  }

  const archiveDetail = /^\/api\/archives\/(\d+)$/.exec(path);
  const clanMatch = /^\/api\/clans\/([^/]+)$/.exec(path);
  const knownAdminRoute =
    path === "/api/logs" ||
    path === "/api/archives" ||
    !!archiveDetail ||
    path === "/api/settings" ||
    path === "/api/ranks" ||
    !!clanMatch ||
    path === "/api/reset";
  if (!knownAdminRoute) return json({ error: "not found" }, 404);

  const expectedMethod =
    path === "/api/settings" || path === "/api/ranks" || clanMatch ? "PUT" :
      path === "/api/reset" ? "POST" : "GET";
  if (method !== expectedMethod) return json({ error: "method" }, 405);
  const token = await adminToken(request, db);
  if (!token) return json({ error: "需要管理员权限" }, 403);

  if (path === "/api/logs") {
    const rows = await all(db, "SELECT * FROM logs ORDER BY id DESC LIMIT 300");
    return json({
      logs: rows.map(row => ({
        time: new Date(row.time).toLocaleString("zh-CN", { hour12: false }),
        type: row.type,
        clan: row.clan,
        details: row.details,
        operator: row.operator,
        token: row.token
      }))
    });
  }

  if (path === "/api/archives") {
    const rows = await all(db, "SELECT id, period, created_at FROM archives ORDER BY id DESC");
    return json({
      archives: rows.map(row => ({
        id: row.id,
        period: row.period,
        createdAt: new Date(row.created_at).toLocaleString("zh-CN", { hour12: false })
      }))
    });
  }

  if (archiveDetail) {
    const row = await first(db, "SELECT * FROM archives WHERE id = ?", Number(archiveDetail[1]));
    if (!row) return json({ error: "归档不存在" }, 404);
    return json({
      period: row.period,
      createdAt: new Date(row.created_at).toLocaleString("zh-CN", { hour12: false }),
      data: JSON.parse(row.payload)
    });
  }

  if (path === "/api/settings") {
    const body = await readJson(request);
    const mainTitle = String(body.mainTitle || "").trim().slice(0, 60);
    const subTitle = String(body.subTitle || "").trim().slice(0, 80);
    if (!mainTitle || !subTitle) return json({ error: "标题不能为空" }, 400);
    await batch(db, [
      stmt(db, "INSERT INTO settings(key, value) VALUES('mainTitle', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", mainTitle),
      stmt(db, "INSERT INTO settings(key, value) VALUES('subTitle', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", subTitle),
      stmt(db, "INSERT INTO logs(time, type, clan, details, operator, token) VALUES(?, 'EDIT', '全局设置', ?, '管理员', ?)", Date.now(), `更新标题为「${mainTitle}」`, token),
      revStatement(db)
    ]);
    return json({ ok: true });
  }

  if (path === "/api/ranks") {
    const body = await readJson(request);
    const list = Array.isArray(body.rankOptions) ? body.rankOptions : [];
    const seen = new Set();
    const clean = [];
    for (const rank of list) {
      const value = String(rank && rank.value || "").trim().slice(0, 20);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      clean.push({
        value,
        label: String(rank.label || value).trim().slice(0, 20),
        color: VALID_COLORS.has(rank.color) ? rank.color : "sky"
      });
    }
    if (!clean.length) return json({ error: "至少保留一个段位" }, 400);
    await batch(db, [
      stmt(db, "INSERT INTO settings(key, value) VALUES('rankOptions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(clean)),
      stmt(db, "INSERT INTO logs(time, type, clan, details, operator, token) VALUES(?, 'EDIT', '全局设置', ?, '管理员', ?)", Date.now(), `更新段位库（共 ${clean.length} 个段位）`, token),
      revStatement(db)
    ]);
    return json({ ok: true });
  }

  if (clanMatch) {
    const clanId = decodePathPart(clanMatch[1]);
    const clan = await first(db, "SELECT * FROM clans WHERE id = ?", clanId);
    if (!clan) return json({ error: "部落不存在" }, 404);
    const body = await readJson(request);
    const name = String(body.name || "").trim().slice(0, 40);
    const tag = String(body.tag || "").trim().slice(0, 20);
    const rank = String(body.rank || "").trim().slice(0, 20);
    const category = String(body.category || "").trim().slice(0, 20);
    const capacity = Math.min(50, Math.max(1, Number.parseInt(body.capacity, 10) || clan.capacity));
    const time = String(body.time || "").trim().slice(0, 60);
    const requirement = String(body.requirement || "").trim().slice(0, 300);
    if (!name || !tag || !rank || !category || !time || !requirement) {
      return json({ error: "存在必填项为空" }, 400);
    }
    const update = stmt(
      db,
      `UPDATE clans SET name = ?, tag = ?, rank = ?, category = ?, capacity = ?, time = ?, requirement = ?
       WHERE id = ? AND ? >= (SELECT COUNT(*) FROM entries WHERE clan_id = ? AND role = 'main')`,
      name, tag, rank, category, capacity, time, requirement, clanId, capacity, clanId
    );
    const results = await batch(db, [
      update,
      logStatement(db, "EDIT", name, "管理员更新了部落信息", "管理员", token),
      revStatement(db)
    ]);
    if (!(results[0]?.meta?.changes > 0)) {
      const count = await first(db, "SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = 'main'", clanId);
      return json({ error: `正选上限不能小于当前已报名人数（${count.n}）` }, 409);
    }
    return json({ ok: true });
  }

  if (path === "/api/reset") {
    const state = await buildState(db, request);
    const hasData = state.clans.some(clan => clan.players.length || clan.subs.length);
    const entryIds = state.clans.flatMap(clan =>
      [...clan.players, ...clan.subs].map(entry => entry.id)
    );
    const now = Date.now();
    const statements = [];
    if (hasData) {
      statements.push(stmt(
        db,
        "INSERT INTO archives(period, created_at, payload) VALUES(?, ?, ?)",
        state.meta.mainTitle || new Date(now).toISOString().slice(0, 7),
        now,
        JSON.stringify({ meta: state.meta, clans: state.clans })
      ));
    }
    statements.push(
      stmt(db, "DELETE FROM entries WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(entryIds)),
      stmt(db, "INSERT INTO logs(time, type, clan, details, operator, token) VALUES(?, 'REMOVE', '全部部落', '管理员清空了所有报名名单（已自动归档）', '管理员', ?)", now, token),
      revStatement(db)
    );
    await batch(db, statements);
    return json({ ok: true, archived: hasData });
  }

  return json({ error: "not found" }, 404);
}

export async function onRequest({ request, env }) {
  try {
    return await handle(request, env);
  } catch (error) {
    console.error("Worker API error:", {
      message: error?.message,
      stack: error?.stack,
      url: request?.url,
      method: request?.method
    });

    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    return json({ error: "服务器内部错误" }, 500);
  }
}
