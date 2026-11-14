/**
 * 部落冲突 联赛统一报名系统 —— 后端服务（零第三方依赖）
 *
 * 运行环境：Node.js >= 22.5（使用内置 node:sqlite）
 * 启动：node server.js   或   npm start
 * 环境变量：
 *   PORT             监听端口，默认 3000
 *   ADMIN_PASSWORD   可选的管理员密码；首次初始化建议设置强密码
 *   DB_FILE          SQLite 数据文件路径，默认 ./data/app.db
 *
 * 安全模型：
 *   - 管理员：POST /api/admin/login 用密码换取 30 天有效的会话令牌（Bearer）
 *   - 普通用户：服务端签发随机设备令牌（浏览器 localStorage 保存），
 *     报名记录归属该令牌；修改/退赛时服务端校验归属，杜绝伪造他
 *   - 所有写操作在服务端校验权限，公开频道伪造事件的问题被彻底解决
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'app.db');
const ADMIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const ROOT = __dirname;
const MAX_BODY = 64 * 1024; // 64KB
const MAX_SUBS_PER_CLAN = 30;
const ADMIN_LOG_TOKEN = '#ADMIN';
// 微信批量导入写入的报名归属该标记：没有任何设备令牌能认领，
// 因此只能由管理员维护（与系统预置名单一致）。
const IMPORT_OWNER_TOKEN = '#SYS_PRESET';
const ALLOWED_TH = new Set(['', '19本', '18本', '17本', '16本', '15本及以下']);

// 展示用时间统一按马来西亚时区（UTC+8）格式化。
// 容器默认时区通常为 UTC，若不显式指定 timeZone，会按 UTC 输出，
// 导致显示的时间比马来西亚时间慢 8 小时。
const DISPLAY_TIME_ZONE = 'Asia/Kuala_Lumpur';
function formatDateTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: DISPLAY_TIME_ZONE });
}

// ---------------------------------------------------------------------------
// 数据库初始化
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS clans (
    id TEXT PRIMARY KEY,
    sort INTEGER NOT NULL,
    name TEXT NOT NULL, tag TEXT NOT NULL, rank TEXT NOT NULL, category TEXT NOT NULL,
    capacity INTEGER NOT NULL, time TEXT NOT NULL, requirement TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    clan_id TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_token TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time INTEGER NOT NULL,
    type TEXT NOT NULL, clan TEXT NOT NULL, details TEXT NOT NULL,
    operator TEXT NOT NULL, token TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_tokens (
    token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entries_clan ON entries(clan_id, role, created_at);
`);

const DEFAULT_RANKS = [
  { value: '冠军3', label: '冠军3', color: 'rose' },
  { value: '泰坦3', label: '泰坦3', color: 'purple' },
  { value: '大师', label: '大师段位', color: 'amber' },
  { value: '水晶2', label: '水晶2', color: 'sky' },
  { value: '传奇', label: '传奇', color: 'indigo' },
  { value: '黄金', label: '黄金', color: 'orange' }
];

const wrap = (names) => names.map((name, idx) => ({
  id: `init_${idx}_${name}`, text: name, owner_token: '#SYS_PRESET'
}));

const SEED_CLANS = [
  { id: 'xiyang', name: '夕阳之秋 (晋级组)', tag: '#2PRCUGGJJ', rank: '泰坦3', category: '泰坦3', capacity: 15, time: '12月1号（下午4点）', requirement: '至少传奇2段位(至少一个号）；考核：传奇1模式 3进2（传奇1段位无需考核）', players: wrap(['永恒星河✨洛', '神话再现✨洛', '黎明之夏✨洛', '春暖花开✨洛', '终为向日✨洛', '荧光之夜✨洛', '大千世界✨洛', '幽冥鬼域✨洛', '雨后春笋✨洛', '夜林之溪✨洛', '闪电龙骑士', 'Allenyip', 'Ace 19本']) },
  { id: 'shikong', name: '时空之旅 (晋级组)', tag: '#2J002JY80', rank: '冠军3', category: '冠军3', capacity: 15, time: '12月1号（下午4点）', requirement: '至少传奇3段位（至少一个号）；考核：传奇3模式 4进3（传奇2及以上无需考核）', players: wrap(['皇家禁卫军 19本', '皇家守护者 19本', 'womeiyouwen 19本', 'karina 19本', 'karina 18本', '微笑走过 19本', 'CN.one微笑走过 19本', '｛+｝alex｛+｝ 18本', '小橙子']) },
  { id: 'piaoxue', name: '飘雪城', tag: '#2CRVVYQPJ', rank: '冠军3', category: '冠军3', capacity: 15, time: '12月1号（下午4点后）', requirement: '19本、（18本最多5个）有打19本3星实力；上次大师1/冠3/泰坦3有18星以上可直接报名，其他找梦幻巧克力审核', players: wrap(['凛冬 19本', '林村 19本', '梦幻巧克力 19本', '寒冰 19本', '15 18本', 'siang 18本', 'tan 18本']) },
  { id: 'xuejingling', name: '雪精灵', tag: '#2GPUCRVR2', rank: '大师2', category: '大师', capacity: 30, time: '12月1号（下午4点后）', requirement: '19本、18本、（17本最多5个）；7次次数必须用完，不可漏刀', players: wrap(['畲族部落 18本', 'WAYNE 17本', 'Dreamland_xiang 17本', '梦夜星空 18本', '我的家 18本']) },
  { id: 'huoyan', name: '火焰部落！', tag: '#Y8UR2GYP', rank: '大师3', category: '大师', capacity: 30, time: '12月1号（下午4点后）', requirement: '19本、18本、17本；7次次数必须用完，不可漏刀', players: wrap(['Peace & Love 17本']) },
  { id: 'siyue', name: '四月是你的谎言 (保级组)', tag: '#2JLLVYUVJ', rank: '水晶2', category: '水晶2', capacity: 30, time: '12月1号（下午4点）', requirement: '无大本营等级限制，积极进攻就行', players: wrap(['Li 17本', 'ℒℴѵℯ信·仔 17本', '王子 17本', 'Maple 16本', 'Kirito 16本', 'Taссаа 15本及以下', 'Bryan_Lzy 17本', '传奇小子3号']) },
  { id: 'bingjingling', name: '冰精灵', tag: '#2QJPQ88LJ', rank: '水晶2', category: '水晶2', capacity: 30, time: '12月1号（下午4点后）', requirement: '1到19本都可参加', players: wrap(['皇家隐秘者 14本']) }
];

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64);
  const hb = Buffer.from(hash, 'hex');
  return h.length === hb.length && crypto.timingSafeEqual(h, hb);
}

function bumpRev() {
  const rev = parseInt(getSetting('rev', '0'), 10) + 1;
  setSetting('rev', rev);
  return rev;
}
function getRev() { return parseInt(getSetting('rev', '0'), 10); }

function addLog(type, clan, details, operator, token) {
  db.prepare('INSERT INTO logs(time, type, clan, details, operator, token) VALUES(?,?,?,?,?,?)')
    .run(Date.now(), type, clan, details, operator || '群友', token || '未知签名');
}

// 初次启动：写入默认设置 / 段位库 / 部落种子数据
function initSeed() {
  if (getSetting('seeded') === '1') return;
  setSetting('mainTitle', 'COC 12月联赛统一报名');
  setSetting('subTitle', '微信群专属防刷屏多部落同步报名系统');
  setSetting('rankOptions', JSON.stringify(DEFAULT_RANKS));
  setSetting('rev', '1');
  const insertClan = db.prepare('INSERT INTO clans(id, sort, name, tag, rank, category, capacity, time, requirement) VALUES(?,?,?,?,?,?,?,?,?)');
  const insertEntry = db.prepare('INSERT INTO entries(id, clan_id, role, name, owner_token, created_at) VALUES(?,?,?,?,?,?)');
  SEED_CLANS.forEach((c, i) => {
    insertClan.run(c.id, i, c.name, c.tag, c.rank, c.category, c.capacity, c.time, c.requirement);
    c.players.forEach((p, j) => insertEntry.run(p.id, c.id, 'main', p.text, p.owner_token, Date.now() + j));
  });
  setSetting('seeded', '1');
}

function initAdminPassword() {
  const envPw = process.env.ADMIN_PASSWORD;
  if (envPw) {
    setSetting('adminPwd', hashPassword(envPw));
  } else if (!getSetting('adminPwd')) {
    console.warn('[警告] 尚未设置管理员密码。请通过 ADMIN_PASSWORD 初始化；系统不再提供默认密码。');
  }
}

initSeed();
initAdminPassword();
db.prepare(`
  INSERT OR IGNORE INTO device_tokens(token, created_at, last_seen)
  SELECT owner_token, MIN(created_at), MAX(created_at)
  FROM entries WHERE owner_token GLOB '#U-*'
  GROUP BY owner_token
`).run();
db.prepare(`
  UPDATE logs SET token = ?
  WHERE length(token) = 48 AND token NOT GLOB '*[^0-9a-fA-F]*'
`).run(ADMIN_LOG_TOKEN);

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------
function getAdminToken(req) {
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(m[1]);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
    return null;
  }
  return m[1];
}
function getDeviceToken(req) {
  const t = String(req.headers['x-device-token'] || '');
  return /^#U-[A-Z0-9]{4,32}$/.test(t) ? t : null;
}
function registerDeviceToken(token) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO device_tokens(token, created_at, last_seen) VALUES(?,?,?)
    ON CONFLICT(token) DO UPDATE SET last_seen = excluded.last_seen
  `).run(token, now, now);
}
function isValidDeviceToken(token) {
  if (!token) return false;
  const known = db.prepare('SELECT token FROM device_tokens WHERE token = ?').get(token);
  if (known) {
    db.prepare('UPDATE device_tokens SET last_seen = ? WHERE token = ?').run(Date.now(), token);
    return true;
  }
  const legacy = db.prepare('SELECT id FROM entries WHERE owner_token = ? LIMIT 1').get(token);
  if (!legacy) return false;
  registerDeviceToken(token);
  return true;
}

// ---------------------------------------------------------------------------
// 微信批量导入：解析固定格式的多行文本
// 兼容两种来源：
//   1) 手动按「部落 | 昵称 | 本数 | 角色」整理（每行一条，后两项可省略）；
//   2) 直接粘贴微信群「接龙」结果（带序号，如「1. 张三 19本」）：
//      自动忽略 #接龙、标题行，去掉序号，按空格解析「昵称 本数 角色」。
// 若请求里已指定默认部落，行首可省略部落名。
// 「本数」取 ALLOWED_TH，「角色」默认正选（正选/替补）。
// ---------------------------------------------------------------------------
const IMPORT_SEPARATOR = /[|｜\t]+/;
const IMPORT_NUMBER_PREFIX = /^\s*\d+\s*[.、．)）:：]\s*/;
const IMPORT_ROLE_ALIASES = {
  '正选': 'main', '主选': 'main', '主力': 'main', 'main': 'main',
  '替补': 'sub', '候补': 'sub', '备选': 'sub', 'sub': 'sub'
};

function normalizeClanKey(value) {
  return String(value || '').replace(/[\s（）()【】\[\]！!·.。]/g, '').toLowerCase();
}

function resolveClanExact(token, clans) {
  const raw = String(token || '').trim();
  const key = normalizeClanKey(raw);
  if (!key) return null;
  return clans.find(c => String(c.id).toLowerCase() === raw.toLowerCase()) ||
    clans.find(c => normalizeClanKey(c.name) === key) || null;
}

function resolveClan(token, clans) {
  const raw = String(token || '').trim();
  const key = normalizeClanKey(raw);
  if (!key) return null;
  const byId = clans.find(c => String(c.id).toLowerCase() === raw.toLowerCase());
  if (byId) return byId;
  const exact = clans.find(c => normalizeClanKey(c.name) === key);
  if (exact) return exact;
  return clans.find(c => {
    const name = normalizeClanKey(c.name);
    return name.includes(key) || key.includes(name);
  }) || null;
}

function resolveHeaderClan(line, clans) {
  const exact = resolveClanExact(line, clans);
  if (exact) return exact;
  const normalized = normalizeClanKey(line);
  return clans.find(c => {
    const name = normalizeClanKey(c.name);
    return normalized.startsWith(name) && /(联赛报名|报名接龙|联赛接龙)/.test(line);
  }) || null;
}

// 行首若带部落名则剥离（兼容「部落 昵称」与「部落 | 昵称」两种写法）。
function stripLeadingClan(body, clans) {
  const separated = body.split(IMPORT_SEPARATOR).map(part => part.trim());
  if (separated.length > 1) {
    const clan = resolveClan(separated[0], clans);
    if (clan) return { clan, rest: separated.slice(1).join(' | ') };
  }
  const tokens = body.split(/[\s|｜\t]+/).filter(Boolean);
  for (let count = 1; count <= Math.min(3, tokens.length); count += 1) {
    const clan = resolveClanExact(tokens.slice(0, count).join(' '), clans);
    if (clan) return { clan, rest: tokens.slice(count).join(' ') };
  }
  for (let count = 1; count <= Math.min(3, tokens.length); count += 1) {
    const clan = resolveClan(tokens.slice(0, count).join(' '), clans);
    if (clan) return { clan, rest: tokens.slice(count).join(' ') };
  }
  return null;
}

// 解析单条内容：优先按分隔符切分；否则按「微信接龙」的空格写法，
// 从末尾剥离「角色」「本数」，余下即为昵称（允许昵称含空格）。
function parseEntryFields(body) {
  if (IMPORT_SEPARATOR.test(body)) {
    const parts = body.split(IMPORT_SEPARATOR).map(part => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    let th = '';
    let role = null;
    for (const extra of parts.slice(1)) {
      if (!th && ALLOWED_TH.has(extra) && extra) { th = extra; continue; }
      const mapped = IMPORT_ROLE_ALIASES[extra] || IMPORT_ROLE_ALIASES[extra.toLowerCase()];
      if (mapped) role = mapped;
    }
    return { name: parts[0], th, role };
  }
  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  let th = '';
  let role = null;
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    const mapped = IMPORT_ROLE_ALIASES[last] || IMPORT_ROLE_ALIASES[last.toLowerCase()];
    if (mapped && !role) { role = mapped; tokens.pop(); continue; }
    if (ALLOWED_TH.has(last) && last && !th) { th = last; tokens.pop(); continue; }
    break;
  }
  return { name: tokens.join(' ').trim(), th, role };
}

function parseImportLines(text, clans, defaultClanId, defaultRole) {
  const defaultClan = defaultClanId ? clans.find(c => c.id === defaultClanId) || null : null;
  const rows = String(text || '').split(/\r?\n/)
    .map((raw, index) => ({ raw, lineNo: index + 1 }))
    .filter(row => row.raw.trim() && !row.raw.trim().startsWith('#'));

  // 出现带序号的行即视为「微信接龙」格式：无序号的行按标题处理并忽略。
  const isRelay = rows.some(row => IMPORT_NUMBER_PREFIX.test(row.raw.trim()));
  let headerClan = null;
  const parsed = [];

  for (const { raw, lineNo } of rows) {
    const trimmed = raw.trim();
    if (isRelay && !IMPORT_NUMBER_PREFIX.test(trimmed)) {
      if (!defaultClan && !headerClan) {
        headerClan = resolveHeaderClan(trimmed, clans);
      }
      continue;
    }
    const body = trimmed.replace(IMPORT_NUMBER_PREFIX, '').trim();
    if (!body) continue;

    let clan = defaultClan || headerClan;
    let rest = body;
    const stripped = stripLeadingClan(body, clans);
    const explicitClan = IMPORT_SEPARATOR.test(body)
      ? resolveClanExact(body.split(IMPORT_SEPARATOR)[0], clans)
      : null;
    const fallbackClan = defaultClan || headerClan;
    if (stripped && IMPORT_SEPARATOR.test(body) &&
        (!fallbackClan || explicitClan || stripped.clan.id === fallbackClan.id)) {
      clan = stripped.clan;
      rest = stripped.rest;
    } else if (!clan && stripped) {
      clan = stripped.clan;
      rest = stripped.rest;
    }
    if (!clan) {
      parsed.push({ line: lineNo, raw: trimmed, ok: false, reason: '未找到对应部落' });
      continue;
    }
    const fields = parseEntryFields(rest);
    const name = fields ? fields.name.slice(0, 40) : '';
    if (!name) {
      parsed.push({ line: lineNo, raw: trimmed, ok: false, reason: '昵称为空' });
      continue;
    }
    const role = fields.role || defaultRole;
    parsed.push({
      line: lineNo, raw: trimmed, ok: true,
      clanId: clan.id, clanName: clan.name, name, th: fields.th,
      role: role === 'sub' ? 'sub' : 'main'
    });
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginRateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) { loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 }); return false; }
  rec.count += 1;
  return rec.count > 8;
}

function requestIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// 通用 IP 级滑动窗口限速（写操作防刷），与 Worker 版行为一致。
// 自建版没有 Cloudflare 的 cf-connecting-ip，直接取 socket 远端地址；
// 若部署在反向代理后，请自行按其转发头调整 requestIp。
const ipRateBuckets = new Map(); // `${scope}:${ip}` -> { count, resetAt }
function ipRateLimited(scope, ip, limit, windowMs) {
  const now = Date.now();
  // 桶数量过大时顺带清理已过期的条目，避免长期运行后无界增长。
  if (ipRateBuckets.size > 5000) {
    for (const [key, rec] of ipRateBuckets) {
      if (now > rec.resetAt) ipRateBuckets.delete(key);
    }
  }
  const key = `${scope}:${ip}`;
  const rec = ipRateBuckets.get(key);
  if (!rec || now > rec.resetAt) {
    ipRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  rec.count += 1;
  return rec.count > limit;
}

// ---------------------------------------------------------------------------
// 状态读取
// ---------------------------------------------------------------------------
function buildState(req) {
  const admin = !!getAdminToken(req);
  const device = getDeviceToken(req);
  const clanRows = db.prepare('SELECT * FROM clans ORDER BY sort ASC').all();
  const entryRows = db.prepare('SELECT * FROM entries ORDER BY created_at ASC, id ASC').all();
  const byClan = {};
  for (const e of entryRows) (byClan[e.clan_id] ||= []).push(e);
  const presentEntry = (entry) => {
    const value = { id: entry.id, text: entry.name };
    if (admin || (device && entry.owner_token === device)) {
      value.ownerToken = entry.owner_token;
    }
    return value;
  };
  const clans = clanRows.map(c => {
    const list = byClan[c.id] || [];
    return {
      id: c.id, name: c.name, tag: c.tag, rank: c.rank, category: c.category,
      capacity: c.capacity, time: c.time, requirement: c.requirement,
      players: list.filter(e => e.role === 'main').map(presentEntry),
      subs: list.filter(e => e.role !== 'main').map(presentEntry)
    };
  });
  return {
    rev: getRev(),
    meta: { mainTitle: getSetting('mainTitle', ''), subTitle: getSetting('subTitle', '') },
    rankOptions: JSON.parse(getSetting('rankOptions', '[]')),
    clans
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // 仅在 HTTPS 下由浏览器生效；HTTP 部署（如本地 8000 端口）会被忽略，不影响功能。
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // 与 Cloudflare Worker 版一致的 CSP：页面样式/图标均为本站静态资源，
  // 内联脚本与 onclick 仍需要 unsafe-inline；其余面尽量收紧。
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
      "form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'"
  );

  try {
    // ---------- 静态资源 ----------
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT, 'dist', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    if (method === 'GET' && (
      p === '/assets/app.css' ||
      p === '/vendor/fontawesome/css/all.min.css' ||
      /^\/vendor\/fontawesome\/webfonts\/[A-Za-z0-9_.-]+$/.test(p)
    )) {
      const assetPath = path.join(ROOT, 'dist', p.slice(1));
      if (!fs.existsSync(assetPath)) return sendJson(res, 404, { error: 'not found' });
      const extension = path.extname(assetPath);
      const contentType = {
        '.css': 'text/css; charset=utf-8',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf',
        '.svg': 'image/svg+xml'
      }[extension] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(assetPath));
    }

    // ---------- 设备令牌 ----------
    if (p === '/api/device' && method === 'POST') {
      if (ipRateLimited('device', requestIp(req), 30, 10 * 60 * 1000)) {
        return sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });
      }
      const token = '#U-' + crypto.randomBytes(8).toString('hex').toUpperCase();
      registerDeviceToken(token);
      return sendJson(res, 200, { deviceToken: token });
    }

    // ---------- 管理端登录 ----------
    if (p === '/api/admin/login' && method === 'POST') {
      const ip = requestIp(req);
      if (loginRateLimited(ip)) return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
      const body = await readBody(req);
      const stored = getSetting('adminPwd');
      if (!verifyPassword(String(body.password || ''), stored)) return sendJson(res, 401, { error: '密码错误' });
      const token = crypto.randomBytes(24).toString('hex');
      db.prepare('INSERT INTO sessions(token, created_at, expires_at) VALUES(?,?,?)').run(token, Date.now(), Date.now() + ADMIN_SESSION_MS);
      return sendJson(res, 200, { adminToken: token, expiresAt: Date.now() + ADMIN_SESSION_MS });
    }
    if (p === '/api/admin/check' && method === 'GET') {
      const t = getAdminToken(req);
      return sendJson(res, 200, { ok: !!t });
    }
    if (p === '/api/admin/logout' && method === 'POST') {
      const t = getAdminToken(req);
      if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 状态 ----------
    if (p === '/api/state' && method === 'GET') {
      const clientRev = url.searchParams.get('rev');
      const forceFull = url.searchParams.get('full') === '1';
      if (!forceFull && clientRev !== null && parseInt(clientRev, 10) === getRev()) {
        return sendJson(res, 200, { rev: getRev(), unchanged: true });
      }
      return sendJson(res, 200, buildState(req));
    }

    // ---------- 用户报名 ----------
    if (p === '/api/signup' && method === 'POST') {
      if (ipRateLimited('signup', requestIp(req), 30, 10 * 60 * 1000)) {
        return sendJson(res, 429, { error: '提交过于频繁，请稍后再试' });
      }
      const actor = getDeviceToken(req);
      if (!actor) return sendJson(res, 400, { error: '缺少或非法的设备令牌' });
      if (!isValidDeviceToken(actor)) return sendJson(res, 403, { error: 'invalid_device_token', message: '设备令牌已失效，请重新获取后重试' });
      const body = await readBody(req);
      const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(String(body.clanId || ''));
      if (!clan) return sendJson(res, 404, { error: '部落不存在' });
      const role = body.role === 'sub' ? 'sub' : 'main';
      const th = ALLOWED_TH.has(body.th) ? body.th : '';
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return sendJson(res, 400, { error: '昵称不能为空' });
      const text = th ? `${name} ${th}` : name;
      const entryId = 'e_' + crypto.randomBytes(8).toString('hex');
      const now = Date.now();
      db.exec('BEGIN IMMEDIATE');
      try {
        if (role === 'main') {
          const cnt = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = 'main'").get(clan.id).n;
          if (cnt >= clan.capacity) { db.exec('ROLLBACK'); return sendJson(res, 409, { error: 'full', message: '正选名额已满，请改报替补' }); }
        } else {
          const cnt = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = 'sub'").get(clan.id).n;
          if (cnt >= MAX_SUBS_PER_CLAN) { db.exec('ROLLBACK'); return sendJson(res, 409, { error: 'sub_full', message: '替补席位已满，请联系管理员' }); }
        }
        db.prepare('INSERT INTO entries(id, clan_id, role, name, owner_token, created_at) VALUES(?,?,?,?,?,?)').run(entryId, clan.id, role, text, actor, now);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      addLog('ADD', clan.name, `新增【${role === 'sub' ? '替补' : '正选'}】：${text}`, name, actor);
      bumpRev();
      return sendJson(res, 200, { ok: true, entryId });
    }

    // ---------- 修改 / 删除 / 移动报名 ----------
    const entryMatch = /^\/api\/entries\/([^/]+)(\/move)?$/.exec(p);
    if (entryMatch) {
      const entryId = decodeURIComponent(entryMatch[1]);
      const isMove = !!entryMatch[2];
      const adminToken = getAdminToken(req);
      const candidateDevice = getDeviceToken(req);
      const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
      if (!entry) return sendJson(res, 404, { error: '报名不存在' });
      const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(entry.clan_id);
      const device = !adminToken && candidateDevice === entry.owner_token && isValidDeviceToken(candidateDevice)
        ? candidateDevice
        : null;

      if (isMove) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method' });
        if (!adminToken) return sendJson(res, 403, { error: '需要管理员权限' });
        const body = await readBody(req);
        const toSub = body.direction === 'toSub';
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = db.prepare('SELECT role FROM entries WHERE id = ?').get(entryId);
          if (!current) { db.exec('ROLLBACK'); return sendJson(res, 404, { error: '报名不存在' }); }
          if (toSub && current.role !== 'sub') {
            const count = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = 'sub'").get(entry.clan_id).n;
            if (count >= MAX_SUBS_PER_CLAN) { db.exec('ROLLBACK'); return sendJson(res, 409, { error: 'sub_full', message: '替补席位已满，请联系管理员' }); }
          }
          if (!toSub && current.role !== 'main') {
            const count = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = 'main'").get(entry.clan_id).n;
            if (count >= clan.capacity) { db.exec('ROLLBACK'); return sendJson(res, 409, { error: 'full', message: '正选已满，无法升为正选' }); }
          }
          db.prepare('UPDATE entries SET role = ? WHERE id = ?').run(toSub ? 'sub' : 'main', entryId);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        addLog('EDIT', clan.name, `${toSub ? '转为替补' : '升为正选'}：${entry.name}`, '管理员', ADMIN_LOG_TOKEN);
        bumpRev();
        return sendJson(res, 200, { ok: true });
      }

      const isOwner = device && entry.owner_token === device;
      if (!adminToken && !isOwner) return sendJson(res, 403, { error: '无权操作该报名' });

      if (method === 'PATCH') {
        const body = await readBody(req);
        const th = ALLOWED_TH.has(body.th) ? body.th : '';
        const name = String(body.name || '').trim().slice(0, 40);
        if (!name) return sendJson(res, 400, { error: '昵称不能为空' });
        const newText = (body.th && th) ? `${name} ${th}` : name;
        db.prepare('UPDATE entries SET name = ?, owner_token = ? WHERE id = ?').run(newText, entry.owner_token, entryId);
        addLog('EDIT', clan.name, `修改报名：${entry.name} ➔ ${newText}`, adminToken ? '管理员' : name, adminToken ? ADMIN_LOG_TOKEN : device);
        bumpRev();
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
        // 保留该报名本人的设备码：即使管理员替他退赛，设备码与历史记录也留在日志中。
        addLog('REMOVE', clan.name, `移除/退赛：${entry.name}${adminToken ? '（管理员操作）' : ''}，原设备码：${entry.owner_token}`, adminToken ? '管理员' : entry.name, entry.owner_token || (adminToken ? ADMIN_LOG_TOKEN : device));
        bumpRev();
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method' });
    }

    // ---------- 管理员：日志 / 归档 / 标题 / 段位 / 部落 / 清档 ----------
    const token = getAdminToken(req);
    if (!token) return sendJson(res, 403, { error: '需要管理员权限' });

    if (p === '/api/logs' && method === 'GET') {
      const rows = db.prepare('SELECT * FROM logs ORDER BY id DESC').all();
      return sendJson(res, 200, {
        logs: rows.map(r => ({
          time: formatDateTime(r.time), type: r.type, clan: r.clan, details: r.details,
          operator: r.operator, token: /^[a-f0-9]{48}$/i.test(r.token || '') ? ADMIN_LOG_TOKEN : r.token
        }))
      });
    }

    if (p === '/api/archives' && method === 'GET') {
      const rows = db.prepare('SELECT id, period, created_at FROM archives ORDER BY id DESC').all();
      return sendJson(res, 200, { archives: rows.map(r => ({ id: r.id, period: r.period, createdAt: formatDateTime(r.created_at) })) });
    }

    const arcMatch = /^\/api\/archives\/(\d+)$/.exec(p);
    if (arcMatch && method === 'GET') {
      const row = db.prepare('SELECT * FROM archives WHERE id = ?').get(parseInt(arcMatch[1], 10));
      if (!row) return sendJson(res, 404, { error: '归档不存在' });
      return sendJson(res, 200, { period: row.period, createdAt: formatDateTime(row.created_at), data: JSON.parse(row.payload) });
    }

    if (p === '/api/settings' && method === 'PUT') {
      const body = await readBody(req);
      const mainTitle = String(body.mainTitle || '').trim().slice(0, 60);
      const subTitle = String(body.subTitle || '').trim().slice(0, 80);
      if (!mainTitle || !subTitle) return sendJson(res, 400, { error: '标题不能为空' });
      setSetting('mainTitle', mainTitle);
      setSetting('subTitle', subTitle);
      addLog('EDIT', '全局设置', `更新标题为「${mainTitle}」`, '管理员', ADMIN_LOG_TOKEN);
      bumpRev();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/ranks' && method === 'PUT') {
      const body = await readBody(req);
      const VALID_COLORS = new Set(['rose', 'orange', 'amber', 'emerald', 'cyan', 'sky', 'indigo', 'purple', 'pink', 'slate']);
      const list = Array.isArray(body.rankOptions) ? body.rankOptions : [];
      const seen = new Set(); const clean = [];
      for (const r of list) {
        const value = String(r && r.value || '').trim().slice(0, 20);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        clean.push({ value, label: String(r.label || value).trim().slice(0, 20), color: VALID_COLORS.has(r.color) ? r.color : 'sky' });
      }
      if (!clean.length) return sendJson(res, 400, { error: '至少保留一个段位' });
      setSetting('rankOptions', JSON.stringify(clean));
      addLog('EDIT', '全局设置', `更新段位库（共 ${clean.length} 个段位）`, '管理员', ADMIN_LOG_TOKEN);
      bumpRev();
      return sendJson(res, 200, { ok: true });
    }

    const clanMatch = /^\/api\/clans\/([^/]+)$/.exec(p);
    if (clanMatch && method === 'PUT') {
      const clanId = decodeURIComponent(clanMatch[1]);
      const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(clanId);
      if (!clan) return sendJson(res, 404, { error: '部落不存在' });
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 40);
      const tag = String(body.tag || '').trim().slice(0, 20);
      const rank = String(body.rank || '').trim().slice(0, 20);
      const category = String(body.category || '').trim().slice(0, 20);
      const capacity = Math.min(50, Math.max(1, parseInt(body.capacity, 10) || clan.capacity));
      const time = String(body.time || '').trim().slice(0, 60);
      const requirement = String(body.requirement || '').trim().slice(0, 300);
      if (!name || !tag || !rank || !category || !time || !requirement) return sendJson(res, 400, { error: '存在必填项为空' });
      const mainCount = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = 'main'").get(clanId).n;
      if (capacity < mainCount) return sendJson(res, 409, { error: `正选上限不能小于当前已报名人数（${mainCount}）` });
      db.prepare('UPDATE clans SET name=?, tag=?, rank=?, category=?, capacity=?, time=?, requirement=? WHERE id=?')
        .run(name, tag, rank, category, capacity, time, requirement, clanId);
      addLog('EDIT', name, '管理员更新了部落信息', '管理员', ADMIN_LOG_TOKEN);
      bumpRev();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/admin/import' && method === 'POST') {
      const body = await readBody(req);
      const clanRows = db.prepare('SELECT id, name, capacity FROM clans ORDER BY sort ASC').all();
      const parsed = parseImportLines(body.text, clanRows, String(body.clanId || ''), body.role === 'sub' ? 'sub' : 'main');
      const skipped = parsed.filter(r => !r.ok).map(r => ({ line: r.line, text: r.raw, reason: r.reason }));
      const demoted = [];
      const now = Date.now();
      const countRole = (clanId, role) =>
        db.prepare('SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = ?').get(clanId, role).n;
      const insertEntry = (clanId, role, text) =>
        db.prepare('INSERT INTO entries(id, clan_id, role, name, owner_token, created_at) VALUES(?,?,?,?,?,?)')
          .run('e_' + crypto.randomBytes(8).toString('hex'), clanId, role, text, IMPORT_OWNER_TOKEN, now);
      const logImport = (clanName, details) =>
        db.prepare('INSERT INTO logs(time, type, clan, details, operator, token) VALUES(?,?,?,?,?,?)')
          .run(now, 'ADD', clanName, details, '管理员', ADMIN_LOG_TOKEN);
      let added = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const item of parsed) {
          if (!item.ok) continue;
          const text = item.th ? `${item.name} ${item.th}` : item.name;
          if (item.role === 'sub') {
            if (countRole(item.clanId, 'sub') >= MAX_SUBS_PER_CLAN) {
              skipped.push({ line: item.line, text: item.raw, reason: '替补席位已满' });
              continue;
            }
            insertEntry(item.clanId, 'sub', text);
            logImport(item.clanName, `批量导入【替补】：${text}`);
            added++;
            continue;
          }
          const capacity = db.prepare('SELECT capacity FROM clans WHERE id = ?').get(item.clanId).capacity;
          if (countRole(item.clanId, 'main') < capacity) {
            insertEntry(item.clanId, 'main', text);
            logImport(item.clanName, `批量导入【正选】：${text}`);
            added++;
            continue;
          }
          // 正选名额已满 → 自动改报替补；替补也满才跳过。
          if (countRole(item.clanId, 'sub') >= MAX_SUBS_PER_CLAN) {
            skipped.push({ line: item.line, text: item.raw, reason: '正选与替补均已满' });
            continue;
          }
          insertEntry(item.clanId, 'sub', text);
          logImport(item.clanName, `批量导入【正选已满自动转替补】：${text}`);
          added++;
          demoted.push({ line: item.line, text: item.raw, clan: item.clanName, name: text });
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (added > 0) bumpRev();
      return sendJson(res, 200, { ok: true, added, total: parsed.length, skipped, demoted });
    }

    if (p === '/api/reset' && method === 'POST') {
      const state = buildState(req);
      const hasData = state.clans.some(c => c.players.length || c.subs.length);
      if (hasData) {
        const period = state.meta.mainTitle || new Date().toISOString().slice(0, 7);
        db.prepare('INSERT INTO archives(period, created_at, payload) VALUES(?,?,?)')
          .run(period, Date.now(), JSON.stringify({ meta: state.meta, clans: state.clans }));
      }
      db.prepare('DELETE FROM entries').run();
      addLog('REMOVE', '全部部落', '管理员清空了所有报名名单（已自动归档）', '管理员', ADMIN_LOG_TOKEN);
      bumpRev();
      return sendJson(res, 200, { ok: true, archived: hasData });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('请求处理异常:', e);
    if (/SQLITE_READONLY|readonly database|attempt to write a readonly database/i.test(e.message || '')) {
      return sendJson(res, 503, {
        error: '报名数据库当前不可写。请将 DB_FILE 设置为可写的持久化磁盘路径（例如 /data/app.db）后重启服务。',
        code: 'DB_READ_ONLY'
      });
    }
    // 不把内部异常信息（SQL 报错、文件路径等）回传给客户端，避免信息泄露；
    // 详情只写服务端日志，客户端统一收到通用错误。
    return sendJson(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  console.log(`部落冲突 联赛报名系统已启动： http://localhost:${PORT}`);
  console.log(`数据库文件： ${DB_FILE}`);
});
