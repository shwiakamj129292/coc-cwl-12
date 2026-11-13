const ADMIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
// PBKDF2-HMAC-SHA256 迭代次数。
// Cloudflare Workers 免费版单请求 CPU 预算只有 10ms，而 210000 次迭代需要约 80ms，
// 会在「初始化密码 / 登录 / 修改密码」时超出预算被运行时终止，前端只能看到 500
// 「服务器内部错误」——这正是之前无论怎么设密码都登不进、改密码必报错的根因。
// 这里改为 10000 次（实测约 4ms，安全地落在免费版预算内）。
// 付费版（CPU 上限 30s）可通过环境变量 PASSWORD_HASH_ITERATIONS 提高强度。
const PASSWORD_HASH_ITERATIONS = 10000;
const MIN_PASSWORD_HASH_ITERATIONS = 1000;
const MAX_PASSWORD_HASH_ITERATIONS = 1000000;
const DEFAULT_ADMIN_PASSWORD = "";
const MAX_BODY = 64 * 1024;
const ALLOWED_TH = new Set(["", "19本", "18本", "17本", "16本", "15本及以下"]);
const VALID_COLORS = new Set([
  "rose", "orange", "amber", "emerald", "cyan",
  "sky", "indigo", "purple", "pink", "slate"
]);

// ---------------------------------------------------------------------------
// 存储容量治理
// 容量基准以「服务器（Cloudflare D1）实际额度」为准：免费单库 500MB，付费可调。
// 可用环境变量 STORAGE_LIMIT_BYTES 覆盖，或由管理端「存储容量」面板写入 settings。
// ---------------------------------------------------------------------------
const DEFAULT_STORAGE_LIMIT_BYTES = 500 * 1024 * 1024; // 服务器默认额度：500 MB
const STORAGE_PRUNE_TRIGGER = 0.5;  // 使用率超过 50% 才触发清理
const STORAGE_PRUNE_TARGET = 0.45;  // 清理到 45% 即停（留滞回，避免反复抖动、删太狠）
const RECORD_PROTECT_MS = 90 * 24 * 60 * 60 * 1000; // 3 个月内的记录永不删除
// 每行/每表的基础开销（SQLite 行头、索引、页对齐等，用于估算，偏保守）
const ENTRY_ROW_BYTES = 96;
const LOG_ROW_BYTES = 128;
const ARCHIVE_ROW_BYTES = 160;
const DEVICE_ROW_BYTES = 64;
const SESSION_ROW_BYTES = 72;
const LOGIN_ROW_BYTES = 64;
const RATE_ROW_BYTES = 64;
const CLAN_ROW_BYTES = 128;
const SETTINGS_ROW_BYTES = 64;
const BASE_DB_BYTES = 64 * 1024;

// 写操作 IP 级限速（防刷）。数值取得比较宽松，避免影响正常群友报名。
const SIGNUP_RATE_LIMIT = 30;
const SIGNUP_RATE_WINDOW_MS = 10 * 60 * 1000;
const DEVICE_RATE_LIMIT = 30;
const DEVICE_RATE_WINDOW_MS = 10 * 60 * 1000;

// 异常大数据使用告警阈值（用于通知管理员）
const ALERT_ENTRIES_24H = 200;   // 24 小时内新增报名超过该值 → 疑似异常刷量
const ALERT_LOGS_24H = 2000;     // 24 小时内新增日志超过该值 → 疑似异常刷量
const ALERT_LOG_ROWS = 20000;    // 日志总条数超过该值 → 增长较快提醒

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 展示用时间统一按马来西亚时区（UTC+8）格式化。
// Cloudflare Workers 运行时默认时区是 UTC，若不显式指定 timeZone，
// 会按 UTC 输出，导致显示的时间比马来西亚时间慢 8 小时。
const DISPLAY_TIME_ZONE = "Asia/Kuala_Lumpur";
function formatDateTime(ms) {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false, timeZone: DISPLAY_TIME_ZONE });
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

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || "unknown";
}

// 通用 IP 级滑动窗口限速，返回 { exceeded, count, limit }。
// 失败时「放行」（fail-open）：例如 0002 迁移尚未执行、rate_limits 表不存在时，
// 宁可暂时不拦，也不能让正常群友报名失败。
async function checkRateLimit(db, request, scope, limit, windowMs) {
  try {
    return await rateLimitDecision(db, request, scope, limit, windowMs);
  } catch (error) {
    console.warn("rate limit unavailable, allowing request:", error && error.message);
    return { exceeded: false, count: 0, limit };
  }
}

async function rateLimitDecision(db, request, scope, limit, windowMs) {
  const ip = clientIp(request);
  const now = Date.now();
  const row = await first(
    db,
    `INSERT INTO rate_limits(scope, ip, window_start, count) VALUES(?, ?, ?, 1)
     ON CONFLICT(scope, ip) DO UPDATE SET
       window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END,
       count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END
     RETURNING count AS count`,
    scope, ip, now, now - windowMs, now - windowMs
  );
  const count = num(row && row.count);
  // 仅在窗口重置（count === 1）时做一次过期清理，避免每次请求都产生写入。
  if (count <= 1) {
    await stmt(db, "DELETE FROM rate_limits WHERE window_start <= ?", now - 24 * 60 * 60 * 1000).run();
  }
  return { exceeded: count > limit, count, limit };
}

// 登记一个由服务端签发的设备令牌。
async function registerDeviceToken(db, token) {
  const now = Date.now();
  await stmt(
    db,
    "INSERT INTO device_tokens(token, created_at, last_seen) VALUES(?, ?, ?) " +
      "ON CONFLICT(token) DO UPDATE SET last_seen = excluded.last_seen",
    token, now, now
  ).run();
}

// 校验设备令牌是否由本服务端签发过：
//  1) 命中 device_tokens 登记表 → 通过；
//  2) 兼容迁移前签发、尚未登记但已绑定过报名记录的老令牌 → 通过并补登记；
//  3) 格式正确（#U-[A-Z0-9]{4,32}）的令牌首次见到 → 自动登记并通过
//     （保证迁移前已存于用户浏览器 localStorage 的旧令牌不失效，不影响正常报名）；
//  4) 格式不正确的 → 拒绝（这是真正能挡住的伪造/垃圾令牌）。
// 若 0002 迁移尚未执行（表不存在），则优雅退回为「仅格式校验」，避免影响线上正常用户。
async function validDeviceToken(db, request) {
  const token = deviceToken(request);
  if (!token) return null;
  try {
    const known = await first(db, "SELECT token FROM device_tokens WHERE token = ?", token);
    if (known) {
      await stmt(db, "UPDATE device_tokens SET last_seen = ? WHERE token = ?", Date.now(), token).run();
      return token;
    }
    const legacy = await first(db, "SELECT id FROM entries WHERE owner_token = ? LIMIT 1", token);
    if (legacy) {
      await registerDeviceToken(db, token);
      return token;
    }
    // 首次见到的格式正确令牌：自动登记放行，避免迁移前签发的旧令牌失效。
    // （真正的伪造令牌如果连格式都不对，会被 deviceToken() 在最前面过滤掉。）
    await registerDeviceToken(db, token);
    return token;
  } catch (error) {
    console.warn("device_tokens unavailable, falling back to format-only check:", error && error.message);
    return token;
  }
}

// 估算数据库当前占用的字节数。
// D1 没有直接暴露「已用字节」的接口，这里遍历**全部 9 张表**逐表统计
// 文本字节 + 每行固定开销 + 库文件基础开销来估算（偏保守，宁可高估不低估）。
// 表不存在时（例如 0002 迁移尚未执行）跳过该表，不影响其余统计。
async function estimateUsageBytes(db) {
  const safe = sql => first(db, sql).catch(() => null);
  const [entries, logs, archives, devices, sessions, loginAttempts, rateLimits, clans, settings] = await Promise.all([
    first(db, `SELECT COUNT(*) AS n,
      COALESCE(SUM(LENGTH(COALESCE(id,'')) + LENGTH(COALESCE(clan_id,'')) + LENGTH(COALESCE(role,''))
        + LENGTH(COALESCE(name,'')) + LENGTH(COALESCE(owner_token,''))), 0) AS text_bytes FROM entries`),
    first(db, `SELECT COUNT(*) AS n,
      COALESCE(SUM(LENGTH(COALESCE(type,'')) + LENGTH(COALESCE(clan,'')) + LENGTH(COALESCE(details,''))
        + LENGTH(COALESCE(operator,'')) + LENGTH(COALESCE(token,''))), 0) AS text_bytes FROM logs`),
    first(db, `SELECT COUNT(*) AS n,
      COALESCE(SUM(LENGTH(COALESCE(period,'')) + LENGTH(COALESCE(payload,''))), 0) AS text_bytes FROM archives`),
    safe(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(token,''))), 0) AS text_bytes FROM device_tokens`),
    safe(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(token,''))), 0) AS text_bytes FROM sessions`),
    safe(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(ip,''))), 0) AS text_bytes FROM login_attempts`),
    safe(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(scope,'')) + LENGTH(COALESCE(ip,''))), 0) AS text_bytes FROM rate_limits`),
    safe(`SELECT COUNT(*) AS n,
      COALESCE(SUM(LENGTH(COALESCE(id,'')) + LENGTH(COALESCE(name,'')) + LENGTH(COALESCE(tag,''))
        + LENGTH(COALESCE(rank,'')) + LENGTH(COALESCE(category,'')) + LENGTH(COALESCE(time,''))
        + LENGTH(COALESCE(requirement,''))), 0) AS text_bytes FROM clans`),
    safe(`SELECT COUNT(*) AS n,
      COALESCE(SUM(LENGTH(COALESCE(key,'')) + LENGTH(COALESCE(value,''))), 0) AS text_bytes FROM settings`)
  ]);

  const table = (label, row, rowBytes) => {
    const count = num(row && row.n);
    return { label, count, bytes: num(row && row.text_bytes) + count * rowBytes };
  };
  // 逐表明细（用于管理员面板展示，让"全部数据"一目了然）。
  const tables = {
    entries: table("报名记录", entries, ENTRY_ROW_BYTES),
    logs: table("审计日志", logs, LOG_ROW_BYTES),
    archives: table("历史归档", archives, ARCHIVE_ROW_BYTES),
    devices: table("设备令牌", devices, DEVICE_ROW_BYTES),
    sessions: table("管理员会话", sessions, SESSION_ROW_BYTES),
    loginAttempts: table("登录尝试", loginAttempts, LOGIN_ROW_BYTES),
    rateLimits: table("限流记录", rateLimits, RATE_ROW_BYTES),
    clans: table("部落配置", clans, CLAN_ROW_BYTES),
    settings: table("系统设置", settings, SETTINGS_ROW_BYTES)
  };
  let bytes = BASE_DB_BYTES;
  const counts = {};
  for (const key of Object.keys(tables)) {
    bytes += tables[key].bytes;
    counts[key] = tables[key].count;
  }
  return { bytes, counts, tables };
}

async function storageLimitBytes(db, env) {
  const envValue = Number.parseInt(env && env.STORAGE_LIMIT_BYTES, 10);
  if (Number.isInteger(envValue) && envValue > 0) return envValue;
  const row = await first(db, "SELECT value FROM settings WHERE key = 'storageLimitBytes'");
  const stored = Number.parseInt(row && row.value, 10);
  if (Number.isInteger(stored) && stored > 0) return stored;
  return DEFAULT_STORAGE_LIMIT_BYTES;
}

// 异常/风险告警，用于在管理员面板里提醒（这就是「通知管理员」的落点）。
function buildStorageAlerts(stats) {
  const alerts = [];
  const percent = Math.round(stats.percent * 100);
  if (stats.percent >= 0.8) {
    alerts.push({ level: "critical", message: `存储使用率已达 ${percent}%，接近服务器额度上限，请尽快清理或扩容。` });
  } else if (stats.percent > STORAGE_PRUNE_TRIGGER) {
    alerts.push({ level: "warn", message: `存储使用率 ${percent}% 已超过 ${Math.round(STORAGE_PRUNE_TRIGGER * 100)}%，系统会自动清理超期的最旧记录。` });
  }
  if (stats.counts.entries24h >= ALERT_ENTRIES_24H) {
    alerts.push({ level: "warn", message: `最近 24 小时新增报名 ${stats.counts.entries24h} 条，疑似异常批量提交，请留意。` });
  }
  if (stats.counts.logs24h >= ALERT_LOGS_24H) {
    alerts.push({ level: "warn", message: `最近 24 小时新增日志 ${stats.counts.logs24h} 条，疑似异常刷量，请留意。` });
  }
  if (stats.counts.logs >= ALERT_LOG_ROWS) {
    alerts.push({ level: "warn", message: `审计日志累计已达 ${stats.counts.logs} 条，增长较快，建议留意。` });
  }
  return alerts;
}

async function readLastPrune(db) {
  const row = await first(db, "SELECT value FROM settings WHERE key = 'lastStoragePrune'");
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function storageStats(db, env) {
  const usage = await estimateUsageBytes(db);
  const limit = await storageLimitBytes(db, env);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const cut = Date.now() - RECORD_PROTECT_MS;
  const [protectedRow, oldestRow, recentEntries, recentLogs, lastPrune] = await Promise.all([
    first(db, "SELECT COUNT(*) AS n FROM entries WHERE created_at >= ?", cut),
    first(db, "SELECT MIN(created_at) AS t FROM entries"),
    first(db, "SELECT COUNT(*) AS n FROM entries WHERE created_at >= ?", dayAgo),
    first(db, "SELECT COUNT(*) AS n FROM logs WHERE time >= ?", dayAgo),
    readLastPrune(db)
  ]);
  const stats = {
    usedBytes: usage.bytes,
    limitBytes: limit,
    percent: limit > 0 ? Math.min(1, usage.bytes / limit) : 0,
    counts: {
      ...usage.counts,
      entries24h: num(recentEntries && recentEntries.n),
      logs24h: num(recentLogs && recentLogs.n)
    },
    // 逐表明细（表名 → 条数/占用字节），供管理端展示"全部数据"分布。
    tables: usage.tables,
    protectedEntries: num(protectedRow && protectedRow.n),
    oldestEntryAt: num(oldestRow && oldestRow.t) || null,
    pruneTriggerPercent: STORAGE_PRUNE_TRIGGER,
    protectDays: Math.round(RECORD_PROTECT_MS / (24 * 60 * 60 * 1000)),
    protectedSince: cut,
    lastPrune
  };
  stats.alerts = buildStorageAlerts(stats);
  return stats;
}

// 容量治理核心：使用率 > 50% 时，从最旧的自愿清理记录开始删，直到回落到 45% 以下。
// 硬约束：3 个月内的记录永不删除；先删报名、再删超期日志；删多少、最早删到何时都会回报。
async function pruneStorage(db, env) {
  const limit = await storageLimitBytes(db, env);
  const before = await estimateUsageBytes(db);
  const trigger = limit * STORAGE_PRUNE_TRIGGER;
  const target = limit * STORAGE_PRUNE_TARGET;
  const cutoff = Date.now() - RECORD_PROTECT_MS;
  const report = {
    triggered: false,
    finishedAt: Date.now(),
    limitBytes: limit,
    beforeBytes: before.bytes,
    afterBytes: before.bytes,
    deletedEntries: 0,
    deletedLogs: 0,
    oldestDeletedAt: null,
    protectedEntries: 0,
    reachedTarget: false
  };
  if (before.bytes <= trigger) return report;
  report.triggered = true;

  let current = before.bytes;

  // 1) 先清理超过保护期（3 个月）的最旧报名记录。
  for (let guard = 0; guard < 500 && current > target; guard += 1) {
    const rows = await all(
      db,
      `SELECT id, created_at,
        LENGTH(COALESCE(id,'')) + LENGTH(COALESCE(clan_id,'')) + LENGTH(COALESCE(role,''))
        + LENGTH(COALESCE(name,'')) + LENGTH(COALESCE(owner_token,'')) + ${ENTRY_ROW_BYTES} AS bytes
       FROM entries WHERE created_at < ? ORDER BY created_at ASC, id ASC LIMIT 200`,
      cutoff
    );
    if (!rows.length) break;
    const ids = rows.map(row => row.id);
    await stmt(db, "DELETE FROM entries WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).run();
    for (const row of rows) {
      report.deletedEntries += 1;
      report.oldestDeletedAt = row.created_at;
      current -= num(row.bytes);
    }
  }

  // 2) 仍高于目标，再清理超过保护期的最旧审计日志。
  for (let guard = 0; guard < 500 && current > target; guard += 1) {
    const rows = await all(
      db,
      `SELECT id,
        LENGTH(COALESCE(type,'')) + LENGTH(COALESCE(clan,'')) + LENGTH(COALESCE(details,''))
        + LENGTH(COALESCE(operator,'')) + LENGTH(COALESCE(token,'')) + ${LOG_ROW_BYTES} AS bytes
       FROM logs WHERE time < ? ORDER BY id ASC LIMIT 300`,
      cutoff
    );
    if (!rows.length) break;
    const ids = rows.map(row => row.id);
    await stmt(db, "DELETE FROM logs WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).run();
    for (const row of rows) {
      report.deletedLogs += 1;
      current -= num(row.bytes);
    }
  }

  report.afterBytes = Math.max(0, current);
  report.reachedTarget = current <= target;
  const protectedRow = await first(db, "SELECT COUNT(*) AS n FROM entries WHERE created_at >= ?", cutoff);
  report.protectedEntries = num(protectedRow && protectedRow.n);
  report.finishedAt = Date.now();

  if (report.deletedEntries || report.deletedLogs) {
    const oldest = report.oldestDeletedAt
      ? formatDateTime(report.oldestDeletedAt)
      : "无";
    await stmt(
      db,
      "INSERT INTO logs(time, type, clan, details, operator, token) VALUES(?, 'REMOVE', '系统维护', ?, '系统', '容量治理')",
      Date.now(),
      `容量超过 ${Math.round(STORAGE_PRUNE_TRIGGER * 100)}%，自动清理：报名 ${report.deletedEntries} 条、日志 ${report.deletedLogs} 条（最早至 ${oldest}）；3 个月内记录已保留`
    ).run();
  }
  await stmt(
    db,
    "INSERT INTO settings(key, value) VALUES('lastStoragePrune', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    JSON.stringify(report)
  ).run();
  return report;
}

// 清理过期/无用的临时行，避免长期运行后这类表无界增长：
//  - 已过期的管理员会话（令牌失效机制，过期即失效即删）
//  - 早已超出窗口的登录尝试、限流计数
// 这些数据「过期即无用」，删除不影响任何正常功能；表不存在（迁移未执行）时自动跳过。
async function cleanupTransient(db) {
  const now = Date.now();
  const removed = { sessions: 0, rateLimits: 0, loginAttempts: 0 };
  const tasks = [
    ["sessions", "DELETE FROM sessions WHERE expires_at < ?", [now]],
    ["rateLimits", "DELETE FROM rate_limits WHERE window_start < ?", [now - 24 * 60 * 60 * 1000]],
    ["loginAttempts", "DELETE FROM login_attempts WHERE window_start < ?", [now - LOGIN_WINDOW_MS * 4]]
  ];
  for (const [key, sql, values] of tasks) {
    try {
      const result = await stmt(db, sql, ...values).run();
      removed[key] = num(result && result.meta && result.meta.changes);
    } catch (error) {
      // 迁移未执行 / 表不存在时忽略，不影响主流程。
    }
  }
  return removed;
}

// 由 Cron 定时触发 / 管理员手动触发。
export async function runMaintenance(env) {
  const db = env && env.DB;
  if (!db) return null;
  try {
    const prune = await pruneStorage(db, env);
    const cleaned = await cleanupTransient(db);
    return { prune, cleaned };
  } catch (error) {
    console.error("Storage maintenance failed:", { message: error && error.message, stack: error && error.stack });
    return null;
  }
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

// 允许通过环境变量覆盖迭代次数（付费版可调高），并做范围约束，防止误配。
function passwordIterations(env) {
  const value = Number.parseInt(env && env.PASSWORD_HASH_ITERATIONS, 10);
  if (Number.isInteger(value) &&
      value >= MIN_PASSWORD_HASH_ITERATIONS && value <= MAX_PASSWORD_HASH_ITERATIONS) {
    return value;
  }
  return PASSWORD_HASH_ITERATIONS;
}

// 参考开源社区常用做法：随机盐 + PBKDF2-HMAC-SHA256（Web Crypto）。
// 存储格式：`<iterations>$<saltHex>$<hashHex>`（自描述，便于日后平滑调参）。
async function hashPassword(password, saltHex, iterations) {
  const rounds = iterations || PASSWORD_HASH_ITERATIONS;
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
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds },
    key,
    256
  );
  return `${rounds}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, encoded) {
  const [iterationText, saltHex, expectedHex, extra] = String(encoded || "").split("$");
  const rounds = Number(iterationText);
  const expected = hexToBytes(expectedHex || "");
  if (extra !== undefined || !Number.isInteger(rounds) ||
      rounds < MIN_PASSWORD_HASH_ITERATIONS || rounds > MAX_PASSWORD_HASH_ITERATIONS || !expected) {
    return false;
  }
  const actualHex = (await hashPassword(password, saltHex, rounds)).split("$")[2];
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
  if (storedHash) return verifyPassword(candidate, storedHash.value);
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

  const encoded = await hashPassword(password, null, passwordIterations(env));
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

  const encoded = await hashPassword(newPassword, null, passwordIterations(env));
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
    const rate = await checkRateLimit(db, request, "device", DEVICE_RATE_LIMIT, DEVICE_RATE_WINDOW_MS);
    if (rate.exceeded) return json({ error: "请求过于频繁，请稍后再试" }, 429);
    const token = `#U-${randomHex(8).toUpperCase()}`;
    // 记录签发过的令牌，报名/修改时据此校验，杜绝伪造令牌制造垃圾数据。
    try { await registerDeviceToken(db, token); }
    catch (error) { console.warn("registerDeviceToken failed:", error && error.message); }
    return json({ deviceToken: token });
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
        createdAt: formatDateTime(e.created_at)
      }))
    });
  }

  // 管理员「存储容量」面板：查看实时用量、服务器额度、告警与上次清理结果。
  if (path === "/api/admin/storage") {
    const token = await adminToken(request, db);
    if (!token) return json({ error: "需要管理员权限" }, 403);
    if (method === "GET") return json(await storageStats(db, env));
    if (method === "PUT") {
      // 允许管理员把额度改成「服务器实际给的容量」（MB）。
      const body = await readJson(request);
      const mb = Number.parseFloat(body.limitMB);
      if (!Number.isFinite(mb) || mb < 1 || mb > 102400) {
        return json({ error: "容量上限需为 1 至 102400 之间的数字（MB）" }, 400);
      }
      const bytes = Math.round(mb * 1024 * 1024);
      await stmt(
        db,
        "INSERT INTO settings(key, value) VALUES('storageLimitBytes', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(bytes)
      ).run();
      return json({ ok: true, limitBytes: bytes });
    }
    return json({ error: "method" }, 405);
  }

  // 管理员手动触发一次容量清理，返回本次清理报告。
  if (path === "/api/admin/storage/prune") {
    if (method !== "POST") return json({ error: "method" }, 405);
    const token = await adminToken(request, db);
    if (!token) return json({ error: "需要管理员权限" }, 403);
    const cleaned = await cleanupTransient(db);
    const report = await pruneStorage(db, env);
    return json({ ok: true, report, cleaned, stats: await storageStats(db, env) });
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
    const rate = await checkRateLimit(db, request, "signup", SIGNUP_RATE_LIMIT, SIGNUP_RATE_WINDOW_MS);
    if (rate.exceeded) return json({ error: "提交过于频繁，请稍后再试" }, 429);
    // 只接受服务端签发过（或迁移前已绑定过报名）的设备令牌。
    const actor = await validDeviceToken(db, request);
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
    // 归属判定同样要求令牌是服务端签发过的，伪造令牌无法认领/篡改报名。
    const device = await validDeviceToken(db, request);

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
      // 删除报名时，日志里始终记录「该报名本人的设备码」而不是管理员令牌，
      // 这样即便管理员替他退赛，这个人的设备码与历史报名记录也会永久留在日志中
      // （任何人都删不掉，因为只新增不修改），便于日后核对迁移前/退赛前的数据。
      const result = await saveChange(
        db,
        stmt(db, `DELETE FROM entries WHERE ${condition}`, ...args),
        logStatement(
          db,
          "REMOVE",
          clan.name,
          `移除/退赛：${entry.name}${admin ? "（管理员操作）" : ""}，原设备码：${entry.owner_token}`,
          admin ? "管理员" : entry.name,
          entry.owner_token || admin || device
        )
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
    // 返回全部历史记录（不再截断），管理员可下拉查看完整报名/操作历史。
    const rows = await all(db, "SELECT * FROM logs ORDER BY id DESC");
    return json({
      logs: rows.map(row => ({
        time: formatDateTime(row.time),
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
        createdAt: formatDateTime(row.created_at)
      }))
    });
  }

  if (archiveDetail) {
    const row = await first(db, "SELECT * FROM archives WHERE id = ?", Number(archiveDetail[1]));
    if (!row) return json({ error: "归档不存在" }, 404);
    return json({
      period: row.period,
      createdAt: formatDateTime(row.created_at),
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
