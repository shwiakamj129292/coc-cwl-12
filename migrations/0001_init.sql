CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE clans (
  id TEXT PRIMARY KEY,
  sort INTEGER NOT NULL,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  rank TEXT NOT NULL,
  category TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  time TEXT NOT NULL,
  requirement TEXT NOT NULL
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  clan_id TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_entries_clan ON entries(clan_id, role, created_at);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time INTEGER NOT NULL,
  type TEXT NOT NULL,
  clan TEXT NOT NULL,
  details TEXT NOT NULL,
  operator TEXT NOT NULL,
  token TEXT NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('mainTitle', 'COC 联赛统一报名'),
  ('subTitle', '微信群专属防刷屏多部落同步报名系统'),
  ('rankOptions', '[{"value":"冠军3","label":"冠军3","color":"rose"},{"value":"泰坦3","label":"泰坦3","color":"purple"},{"value":"大师","label":"大师段位","color":"amber"},{"value":"水晶2","label":"水晶2","color":"sky"},{"value":"传奇","label":"传奇","color":"indigo"},{"value":"黄金","label":"黄金","color":"orange"}]'),
  ('rev', '2'),
  ('seeded', '1');

INSERT INTO clans (id, sort, name, tag, rank, category, capacity, time, requirement) VALUES
  ('xiyang', 0, '示例部落 A (晋级组)', '#AAAAAAA1', '泰坦3', '泰坦3', 15, '比赛日（下午4点）', '示例要求：请在此填写你部落的段位与考核说明'),
  ('shikong', 1, '示例部落 B (晋级组)', '#AAAAAAA2', '冠军3', '冠军3', 15, '比赛日（下午4点）', '示例要求：请在此填写你部落的段位与考核说明'),
  ('piaoxue', 2, '示例部落 C', '#AAAAAAA3', '冠军3', '冠军3', 15, '比赛日（下午4点后）', '示例要求：请在此填写你部落的段位与考核说明'),
  ('xuejingling', 3, '示例部落 D', '#AAAAAAA4', '大师2', '大师', 30, '比赛日（下午4点后）', '示例要求：请在此填写你部落的段位与考核说明'),
  ('huoyan', 4, '示例部落 E', '#AAAAAAA5', '大师3', '大师', 30, '比赛日（下午4点后）', '示例要求：请在此填写你部落的段位与考核说明'),
  ('siyue', 5, '示例部落 F (保级组)', '#AAAAAAA6', '水晶2', '水晶2', 30, '比赛日（下午4点）', '示例要求：请在此填写你部落的段位与考核说明'),
  ('bingjingling', 6, '示例部落 G', '#AAAAAAA7', '水晶2', '水晶2', 30, '比赛日（下午4点后）', '示例要求：请在此填写你部落的段位与考核说明');

INSERT INTO entries (id, clan_id, role, name, owner_token, created_at) VALUES
  ('init_0_示例玩家 A1', 'xiyang', 'main', '示例玩家 A1', '#SYS_PRESET', 1794509531343),
  ('init_1_示例玩家 A2', 'xiyang', 'main', '示例玩家 A2', '#SYS_PRESET', 1794509531344),
  ('init_2_示例玩家 A3', 'xiyang', 'main', '示例玩家 A3', '#SYS_PRESET', 1794509531345),
  ('init_3_示例玩家 A4', 'xiyang', 'main', '示例玩家 A4', '#SYS_PRESET', 1794509531346),
  ('init_4_示例玩家 A5', 'xiyang', 'main', '示例玩家 A5', '#SYS_PRESET', 1794509531347),
  ('init_5_示例玩家 A6', 'xiyang', 'main', '示例玩家 A6', '#SYS_PRESET', 1794509531348),
  ('init_6_示例玩家 A7', 'xiyang', 'main', '示例玩家 A7', '#SYS_PRESET', 1794509531349),
  ('init_7_示例玩家 A8', 'xiyang', 'main', '示例玩家 A8', '#SYS_PRESET', 1794509531350),
  ('init_8_示例玩家 A9', 'xiyang', 'main', '示例玩家 A9', '#SYS_PRESET', 1794509531351),
  ('init_9_示例玩家 A10', 'xiyang', 'main', '示例玩家 A10', '#SYS_PRESET', 1794509531352),
  ('init_10_示例玩家 A11', 'xiyang', 'main', '示例玩家 A11', '#SYS_PRESET', 1794509531353),
  ('init_11_示例玩家 A12', 'xiyang', 'main', '示例玩家 A12', '#SYS_PRESET', 1794509531354),
  ('init_12_示例玩家 A13', 'xiyang', 'main', '示例玩家 A13', '#SYS_PRESET', 1794509531355),
  ('init_0_示例玩家 B1', 'shikong', 'main', '示例玩家 B1', '#SYS_PRESET', 1794509531356),
  ('init_1_示例玩家 B2', 'shikong', 'main', '示例玩家 B2', '#SYS_PRESET', 1794509531357),
  ('init_2_示例玩家 B3', 'shikong', 'main', '示例玩家 B3', '#SYS_PRESET', 1794509531358),
  ('init_3_示例玩家 B4', 'shikong', 'main', '示例玩家 B4', '#SYS_PRESET', 1794509531359),
  ('init_4_示例玩家 B5', 'shikong', 'main', '示例玩家 B5', '#SYS_PRESET', 1794509531360),
  ('init_5_示例玩家 B6', 'shikong', 'main', '示例玩家 B6', '#SYS_PRESET', 1794509531361),
  ('init_6_示例玩家 B7', 'shikong', 'main', '示例玩家 B7', '#SYS_PRESET', 1794509531362),
  ('init_7_示例玩家 B8', 'shikong', 'main', '示例玩家 B8', '#SYS_PRESET', 1794509531363),
  ('init_8_示例玩家 B9', 'shikong', 'main', '示例玩家 B9', '#SYS_PRESET', 1794509531364),
  ('init_0_示例玩家 C1', 'piaoxue', 'main', '示例玩家 C1', '#SYS_PRESET', 1794509531365),
  ('init_1_示例玩家 C2', 'piaoxue', 'main', '示例玩家 C2', '#SYS_PRESET', 1794509531366),
  ('init_2_示例玩家 C3', 'piaoxue', 'main', '示例玩家 C3', '#SYS_PRESET', 1794509531367),
  ('init_3_示例玩家 C4', 'piaoxue', 'main', '示例玩家 C4', '#SYS_PRESET', 1794509531368),
  ('init_4_示例玩家 C5', 'piaoxue', 'main', '示例玩家 C5', '#SYS_PRESET', 1794509531369),
  ('init_5_示例玩家 C6', 'piaoxue', 'main', '示例玩家 C6', '#SYS_PRESET', 1794509531370),
  ('init_6_示例玩家 C7', 'piaoxue', 'main', '示例玩家 C7', '#SYS_PRESET', 1794509531371),
  ('init_0_示例玩家 D1', 'xuejingling', 'main', '示例玩家 D1', '#SYS_PRESET', 1794509531372),
  ('init_1_示例玩家 D2', 'xuejingling', 'main', '示例玩家 D2', '#SYS_PRESET', 1794509531373),
  ('init_2_示例玩家 D3', 'xuejingling', 'main', '示例玩家 D3', '#SYS_PRESET', 1794509531374),
  ('init_3_示例玩家 D4', 'xuejingling', 'main', '示例玩家 D4', '#SYS_PRESET', 1794509531375),
  ('init_4_示例玩家 D5', 'xuejingling', 'main', '示例玩家 D5', '#SYS_PRESET', 1794509531376),
  ('init_0_示例玩家 E1', 'huoyan', 'main', '示例玩家 E1', '#SYS_PRESET', 1794509531377),
  ('init_0_示例玩家 F1', 'siyue', 'main', '示例玩家 F1', '#SYS_PRESET', 1794509531378),
  ('init_1_示例玩家 F2', 'siyue', 'main', '示例玩家 F2', '#SYS_PRESET', 1794509531379),
  ('init_2_示例玩家 F3', 'siyue', 'main', '示例玩家 F3', '#SYS_PRESET', 1794509531380),
  ('init_3_示例玩家 F4', 'siyue', 'main', '示例玩家 F4', '#SYS_PRESET', 1794509531381),
  ('init_4_示例玩家 F5', 'siyue', 'main', '示例玩家 F5', '#SYS_PRESET', 1794509531382),
  ('init_5_示例玩家 F6', 'siyue', 'main', '示例玩家 F6', '#SYS_PRESET', 1794509531383),
  ('init_6_示例玩家 F7', 'siyue', 'main', '示例玩家 F7', '#SYS_PRESET', 1794509531384),
  ('init_7_示例玩家 F8', 'siyue', 'main', '示例玩家 F8', '#SYS_PRESET', 1794509531385),
  ('init_0_示例玩家 G1', 'bingjingling', 'main', '示例玩家 G1', '#SYS_PRESET', 1794509531386);
