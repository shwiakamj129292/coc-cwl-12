/**
 * 部落冲突 联赛统一报名系统 —— 后端服务（零第三方依赖）
 *
 * 运行环境：Node.js >= 22.5（使用内置 node:sqlite）
 * 启动：node server.js   或   npm start
 * 环境变量：
 *   PORT             监听端口，默认 3000
 *   ADMIN_PASSWORD   管理员密码；不设置则首次启动初始化为默认 "0921"（请务必修改）
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
const ALLOWED_TH = new Set(['', '19本', '18本', '17本', '16本', '15本及以下']);

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
    return;
  }
  if (!getSetting('adminPwd')) {
    setSetting('adminPwd', hashPassword('0921'));
    console.warn('[警告] 未设置 ADMIN_PASSWORD，已使用默认密码 0921，请尽快通过环境变量修改！');
  }
}

initSeed();
initAdminPassword();

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

// ---------------------------------------------------------------------------
// 状态读取
// ---------------------------------------------------------------------------
function buildState() {
  const clanRows = db.prepare('SELECT * FROM clans ORDER BY sort ASC').all();
  const entryRows = db.prepare('SELECT * FROM entries ORDER BY created_at ASC, id ASC').all();
  const byClan = {};
  for (const e of entryRows) (byClan[e.clan_id] ||= []).push(e);
  const clans = clanRows.map(c => {
    const list = byClan[c.id] || [];
    return {
      id: c.id, name: c.name, tag: c.tag, rank: c.rank, category: c.category,
      capacity: c.capacity, time: c.time, requirement: c.requirement,
      players: list.filter(e => e.role === 'main').map(e => ({ id: e.id, text: e.name, ownerToken: e.owner_token })),
      subs: list.filter(e => e.role !== 'main').map(e => ({ id: e.id, text: e.name, ownerToken: e.owner_token }))
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

  try {
    // ---------- 静态资源 ----------
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }

    // ---------- 设备令牌 ----------
    if (p === '/api/device' && method === 'POST') {
      const token = '#U-' + crypto.randomBytes(8).toString('hex').toUpperCase();
      return sendJson(res, 200, { deviceToken: token });
    }

    // ---------- 管理端登录 ----------
    if (p === '/api/admin/login' && method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
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
      if (clientRev !== null && parseInt(clientRev, 10) === getRev()) {
        return sendJson(res, 200, { rev: getRev(), unchanged: true });
      }
      return sendJson(res, 200, buildState());
    }

    // ---------- 用户报名 ----------
    if (p === '/api/signup' && method === 'POST') {
      const actor = getDeviceToken(req);
      if (!actor) return sendJson(res, 400, { error: '缺少或非法的设备令牌' });
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
      const device = getDeviceToken(req);
      const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
      if (!entry) return sendJson(res, 404, { error: '报名不存在' });
      const clan = db.prepare('SELECT * FROM clans WHERE id = ?').get(entry.clan_id);

      if (isMove) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method' });
        if (!adminToken) return sendJson(res, 403, { error: '需要管理员权限' });
        const body = await readBody(req);
        const toSub = body.direction === 'toSub';
        if (!toSub && entry.role !== 'main') {
          const cnt = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE clan_id = ? AND role = 'main'").get(entry.clan_id).n;
          if (cnt >= clan.capacity) return sendJson(res, 409, { error: '正选已满，无法升为正选' });
        }
        db.prepare('UPDATE entries SET role = ? WHERE id = ?').run(toSub ? 'sub' : 'main', entryId);
        addLog('EDIT', clan.name, `${toSub ? '转为替补' : '升为正选'}：${entry.name}`, '管理员', adminToken);
        bumpRev();
        return sendJson(res, 200, { ok: true });
      }

      const isOwner = device && entry.owner_token === device;
      const canClaim = !adminToken && device && entry.owner_token === '#SYS_PRESET';
      if (!adminToken && !isOwner && !canClaim) return sendJson(res, 403, { error: '无权操作该报名' });

      if (method === 'PATCH') {
        const body = await readBody(req);
        const th = ALLOWED_TH.has(body.th) ? body.th : '';
        const name = String(body.name || '').trim().slice(0, 40);
        if (!name) return sendJson(res, 400, { error: '昵称不能为空' });
        const newText = (body.th && th) ? `${name} ${th}` : name;
        const newOwner = canClaim ? device : entry.owner_token;
        db.prepare('UPDATE entries SET name = ?, owner_token = ? WHERE id = ?').run(newText, newOwner, entryId);
        addLog('EDIT', clan.name, `修改报名：${entry.name} ➔ ${newText}`, name, adminToken || device);
        bumpRev();
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
        // 保留该报名本人的设备码：即使管理员替他退赛，设备码与历史记录也留在日志中。
        addLog('REMOVE', clan.name, `移除/退赛：${entry.name}${adminToken ? '（管理员操作）' : ''}，原设备码：${entry.owner_token}`, adminToken ? '管理员' : entry.name, entry.owner_token || adminToken || device);
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
        logs: rows.map(r => ({ time: new Date(r.time).toLocaleString('zh-CN', { hour12: false }), type: r.type, clan: r.clan, details: r.details, operator: r.operator, token: r.token }))
      });
    }

    if (p === '/api/archives' && method === 'GET') {
      const rows = db.prepare('SELECT id, period, created_at FROM archives ORDER BY id DESC').all();
      return sendJson(res, 200, { archives: rows.map(r => ({ id: r.id, period: r.period, createdAt: new Date(r.created_at).toLocaleString('zh-CN', { hour12: false }) })) });
    }

    const arcMatch = /^\/api\/archives\/(\d+)$/.exec(p);
    if (arcMatch && method === 'GET') {
      const row = db.prepare('SELECT * FROM archives WHERE id = ?').get(parseInt(arcMatch[1], 10));
      if (!row) return sendJson(res, 404, { error: '归档不存在' });
      return sendJson(res, 200, { period: row.period, createdAt: new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }), data: JSON.parse(row.payload) });
    }

    if (p === '/api/settings' && method === 'PUT') {
      const body = await readBody(req);
      const mainTitle = String(body.mainTitle || '').trim().slice(0, 60);
      const subTitle = String(body.subTitle || '').trim().slice(0, 80);
      if (!mainTitle || !subTitle) return sendJson(res, 400, { error: '标题不能为空' });
      setSetting('mainTitle', mainTitle);
      setSetting('subTitle', subTitle);
      addLog('EDIT', '全局设置', `更新标题为「${mainTitle}」`, '管理员', token);
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
      addLog('EDIT', '全局设置', `更新段位库（共 ${clean.length} 个段位）`, '管理员', token);
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
      addLog('EDIT', name, '管理员更新了部落信息', '管理员', token);
      bumpRev();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/reset' && method === 'POST') {
      const state = buildState();
      const hasData = state.clans.some(c => c.players.length || c.subs.length);
      if (hasData) {
        const period = state.meta.mainTitle || new Date().toISOString().slice(0, 7);
        db.prepare('INSERT INTO archives(period, created_at, payload) VALUES(?,?,?)')
          .run(period, Date.now(), JSON.stringify({ meta: state.meta, clans: state.clans }));
      }
      db.prepare('DELETE FROM entries').run();
      addLog('REMOVE', '全部部落', '管理员清空了所有报名名单（已自动归档）', '管理员', token);
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
    return sendJson(res, 500, { error: e.message || '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  console.log(`部落冲突 联赛报名系统已启动： http://localhost:${PORT}`);
  console.log(`数据库文件： ${DB_FILE}`);
});
