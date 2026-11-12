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
  ('mainTitle', 'COC 12月联赛统一报名'),
  ('subTitle', '微信群专属防刷屏多部落同步报名系统'),
  ('rankOptions', '[{"value":"冠军3","label":"冠军3","color":"rose"},{"value":"泰坦3","label":"泰坦3","color":"purple"},{"value":"大师","label":"大师段位","color":"amber"},{"value":"水晶2","label":"水晶2","color":"sky"},{"value":"传奇","label":"传奇","color":"indigo"},{"value":"黄金","label":"黄金","color":"orange"}]'),
  ('rev', '2'),
  ('seeded', '1');

INSERT INTO clans (id, sort, name, tag, rank, category, capacity, time, requirement) VALUES
  ('xiyang', 0, '夕阳之秋 (晋级组)', '#2PRCUGGJJ', '泰坦3', '泰坦3', 15, '12月1号（下午4点）', '至少传奇2段位(至少一个号）；考核：传奇1模式 3进2（传奇1段位无需考核）'),
  ('shikong', 1, '时空之旅 (晋级组)', '#2J002JY80', '冠军3', '冠军3', 15, '12月1号（下午4点）', '至少传奇3段位（至少一个号）；考核：传奇3模式 4进3（传奇2及以上无需考核）'),
  ('piaoxue', 2, '飘雪城', '#2CRVVYQPJ', '冠军3', '冠军3', 15, '12月1号（下午4点后）', '19本、（18本最多5个）有打19本3星实力；上次大师1/冠3/泰坦3有18星以上可直接报名，其他找梦幻巧克力审核'),
  ('xuejingling', 3, '雪精灵', '#2GPUCRVR2', '大师2', '大师', 30, '12月1号（下午4点后）', '19本、18本、（17本最多5个）；7次次数必须用完，不可漏刀'),
  ('huoyan', 4, '火焰部落！', '#Y8UR2GYP', '大师3', '大师', 30, '12月1号（下午4点后）', '19本、18本、17本；7次次数必须用完，不可漏刀'),
  ('siyue', 5, '四月是你的谎言 (保级组)', '#2JLLVYUVJ', '水晶2', '水晶2', 30, '12月1号（下午4点）', '无大本营等级限制，积极进攻就行'),
  ('bingjingling', 6, '冰精灵', '#2QJPQ88LJ', '水晶2', '水晶2', 30, '12月1号（下午4点后）', '1到19本都可参加');

INSERT INTO entries (id, clan_id, role, name, owner_token, created_at) VALUES
  ('init_0_永恒星河✨洛', 'xiyang', 'main', '永恒星河✨洛', '#SYS_PRESET', 1794509531343),
  ('init_1_神话再现✨洛', 'xiyang', 'main', '神话再现✨洛', '#SYS_PRESET', 1794509531344),
  ('init_2_黎明之夏✨洛', 'xiyang', 'main', '黎明之夏✨洛', '#SYS_PRESET', 1794509531345),
  ('init_3_春暖花开✨洛', 'xiyang', 'main', '春暖花开✨洛', '#SYS_PRESET', 1794509531346),
  ('init_4_终为向日✨洛', 'xiyang', 'main', '终为向日✨洛', '#SYS_PRESET', 1794509531347),
  ('init_5_荧光之夜✨洛', 'xiyang', 'main', '荧光之夜✨洛', '#SYS_PRESET', 1794509531348),
  ('init_6_大千世界✨洛', 'xiyang', 'main', '大千世界✨洛', '#SYS_PRESET', 1794509531349),
  ('init_7_幽冥鬼域✨洛', 'xiyang', 'main', '幽冥鬼域✨洛', '#SYS_PRESET', 1794509531350),
  ('init_8_雨后春笋✨洛', 'xiyang', 'main', '雨后春笋✨洛', '#SYS_PRESET', 1794509531351),
  ('init_9_夜林之溪✨洛', 'xiyang', 'main', '夜林之溪✨洛', '#SYS_PRESET', 1794509531352),
  ('init_10_闪电龙骑士', 'xiyang', 'main', '闪电龙骑士', '#SYS_PRESET', 1794509531353),
  ('init_11_Allenyip', 'xiyang', 'main', 'Allenyip', '#SYS_PRESET', 1794509531354),
  ('init_12_Ace 19本', 'xiyang', 'main', 'Ace 19本', '#SYS_PRESET', 1794509531355),
  ('init_0_皇家禁卫军 19本', 'shikong', 'main', '皇家禁卫军 19本', '#SYS_PRESET', 1794509531356),
  ('init_1_皇家守护者 19本', 'shikong', 'main', '皇家守护者 19本', '#SYS_PRESET', 1794509531357),
  ('init_2_womeiyouwen 19本', 'shikong', 'main', 'womeiyouwen 19本', '#SYS_PRESET', 1794509531358),
  ('init_3_karina 19本', 'shikong', 'main', 'karina 19本', '#SYS_PRESET', 1794509531359),
  ('init_4_karina 18本', 'shikong', 'main', 'karina 18本', '#SYS_PRESET', 1794509531360),
  ('init_5_微笑走过 19本', 'shikong', 'main', '微笑走过 19本', '#SYS_PRESET', 1794509531361),
  ('init_6_CN.one微笑走过 19本', 'shikong', 'main', 'CN.one微笑走过 19本', '#SYS_PRESET', 1794509531362),
  ('init_7_｛+｝alex｛+｝ 18本', 'shikong', 'main', '｛+｝alex｛+｝ 18本', '#SYS_PRESET', 1794509531363),
  ('init_8_小橙子', 'shikong', 'main', '小橙子', '#SYS_PRESET', 1794509531364),
  ('init_0_凛冬 19本', 'piaoxue', 'main', '凛冬 19本', '#SYS_PRESET', 1794509531365),
  ('init_1_林村 19本', 'piaoxue', 'main', '林村 19本', '#SYS_PRESET', 1794509531366),
  ('init_2_梦幻巧克力 19本', 'piaoxue', 'main', '梦幻巧克力 19本', '#SYS_PRESET', 1794509531367),
  ('init_3_寒冰 19本', 'piaoxue', 'main', '寒冰 19本', '#SYS_PRESET', 1794509531368),
  ('init_4_15 18本', 'piaoxue', 'main', '15 18本', '#SYS_PRESET', 1794509531369),
  ('init_5_siang 18本', 'piaoxue', 'main', 'siang 18本', '#SYS_PRESET', 1794509531370),
  ('init_6_tan 18本', 'piaoxue', 'main', 'tan 18本', '#SYS_PRESET', 1794509531371),
  ('init_0_畲族部落 18本', 'xuejingling', 'main', '畲族部落 18本', '#SYS_PRESET', 1794509531372),
  ('init_1_WAYNE 17本', 'xuejingling', 'main', 'WAYNE 17本', '#SYS_PRESET', 1794509531373),
  ('init_2_Dreamland_xiang 17本', 'xuejingling', 'main', 'Dreamland_xiang 17本', '#SYS_PRESET', 1794509531374),
  ('init_3_梦夜星空 18本', 'xuejingling', 'main', '梦夜星空 18本', '#SYS_PRESET', 1794509531375),
  ('init_4_我的家 18本', 'xuejingling', 'main', '我的家 18本', '#SYS_PRESET', 1794509531376),
  ('init_0_Peace & Love 17本', 'huoyan', 'main', 'Peace & Love 17本', '#SYS_PRESET', 1794509531377),
  ('init_0_Li 17本', 'siyue', 'main', 'Li 17本', '#SYS_PRESET', 1794509531378),
  ('init_1_ℒℴѵℯ信·仔 17本', 'siyue', 'main', 'ℒℴѵℯ信·仔 17本', '#SYS_PRESET', 1794509531379),
  ('init_2_王子 17本', 'siyue', 'main', '王子 17本', '#SYS_PRESET', 1794509531380),
  ('init_3_Maple 16本', 'siyue', 'main', 'Maple 16本', '#SYS_PRESET', 1794509531381),
  ('init_4_Kirito 16本', 'siyue', 'main', 'Kirito 16本', '#SYS_PRESET', 1794509531382),
  ('init_5_Taссаа 15本及以下', 'siyue', 'main', 'Taссаа 15本及以下', '#SYS_PRESET', 1794509531383),
  ('init_6_Bryan_Lzy 17本', 'siyue', 'main', 'Bryan_Lzy 17本', '#SYS_PRESET', 1794509531384),
  ('init_7_传奇小子3号', 'siyue', 'main', '传奇小子3号', '#SYS_PRESET', 1794509531385),
  ('init_0_皇家隐秘者 14本', 'bingjingling', 'main', '皇家隐秘者 14本', '#SYS_PRESET', 1794509531386);
