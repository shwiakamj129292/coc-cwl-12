-- 0002：设备令牌签发登记 + IP 级限流 + 存储容量治理
-- 该迁移可安全重复执行（全部使用 IF NOT EXISTS / INSERT OR IGNORE）。
-- 部署后请在 Cloudflare D1 控制台（或 wrangler d1 execute）执行一次本文件。

-- 由服务端签发过的设备令牌登记表。
-- 报名/修改时只接受这里登记过（或迁移前已绑定过报名）的令牌，堵住伪造令牌制造垃圾数据。
CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- IP 级滑动窗口限流（报名、设备令牌签发等写操作防刷）。
CREATE TABLE IF NOT EXISTS rate_limits (
  scope TEXT NOT NULL,
  ip TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, ip)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- 回填迁移前已经签发、并已绑定过报名的老设备令牌，
-- 保证老用户升级后仍可正常修改/退赛，不会因为校验签发记录而被拦下。
INSERT OR IGNORE INTO device_tokens(token, created_at, last_seen)
  SELECT owner_token, MIN(created_at), MAX(created_at)
  FROM entries
  WHERE owner_token LIKE '#U-%'
  GROUP BY owner_token;
