const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");

class TestStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    const migrationsDir = path.join(__dirname, "../migrations");
    const migrations = fs.readdirSync(migrationsDir)
      .filter(name => name.endsWith(".sql"))
      .sort();
    for (const name of migrations) {
      this.database.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
    }
  }

  prepare(sql) {
    return new TestStatement(this.database, sql);
  }

  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const workerPath = path.join(__dirname, "../functions/api/[[path]].js");
const workerSource = fs.readFileSync(workerPath, "utf8");
const workerUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`;
const workerEntrySource = fs.readFileSync(path.join(__dirname, "../worker.js"), "utf8");

async function readJson(response) {
  return response.json();
}

async function loadWorker() {
  const { onRequest, runMaintenance } = await import(workerUrl);
  const factory = new Function(
    "onRequest",
    "runMaintenance",
    workerEntrySource
      .replace(/^import \{ onRequest, runMaintenance \} from ".+";\s*/m, "")
      .replace("export default {", "return {")
  );
  return factory(onRequest, runMaintenance);
}

async function runApi(onRequest, env, route, options = {}) {
  const request = new Request(`https://signup.test${route}`, options);
  return onRequest({ request, env });
}

test("Worker serves built assets instead of rewriting them to index.html", async () => {
  const worker = await loadWorker();
  const requestedPaths = [];
  const env = {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requestedPaths.push(path);
        return new Response(path, {
          headers: { "content-type": path.endsWith(".css") ? "text/css" : "text/html" }
        });
      }
    }
  };

  const cssResponse = await worker.fetch(new Request("https://signup.test/assets/app.css"), env);
  assert.equal(await cssResponse.text(), "/assets/app.css");
  assert.equal(cssResponse.headers.get("content-type"), "text/css");

  const homeResponse = await worker.fetch(new Request("https://signup.test/"), env);
  assert.equal(await homeResponse.text(), "/index.html");
  assert.deepEqual(requestedPaths, ["/assets/app.css", "/index.html"]);
});

test("Pages API seeds data, enforces ownership and capacity, and archives reset", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "test-strong-password" };

  let response = await runApi(onRequest, env, "/api/state");
  let state = await readJson(response);
  assert.equal(state.clans.length, 7);
  assert.equal(state.clans.reduce((n, clan) => n + clan.players.length, 0), 44);

  const tokenA = (await readJson(await runApi(onRequest, env, "/api/device", {
    method: "POST"
  }))).deviceToken;
  const tokenB = (await readJson(await runApi(onRequest, env, "/api/device", {
    method: "POST"
  }))).deviceToken;

  const signup = async (token, name, role = "main") => runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": token },
    body: JSON.stringify({ clanId: "xiyang", name, role, th: "19本" })
  });

  response = await signup(tokenA, "User A");
  assert.equal(response.status, 200);
  const entryId = (await readJson(response)).entryId;

  state = await readJson(await runApi(onRequest, env, "/api/state", {
    headers: { "x-device-token": tokenB }
  }));
  const publicEntry = state.clans.find(clan => clan.id === "xiyang")
    .players.find(entry => entry.id === entryId);
  assert.equal(Object.hasOwn(publicEntry, "ownerToken"), false);

  response = await runApi(onRequest, env, `/api/entries/${entryId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-device-token": tokenB },
    body: JSON.stringify({ name: "forged", th: "19本" })
  });
  assert.equal(response.status, 403);

  response = await runApi(onRequest, env, `/api/entries/${entryId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-device-token": tokenA },
    body: JSON.stringify({ name: "User A edited", th: "19本" })
  });
  assert.equal(response.status, 200);

  assert.equal((await signup(tokenB, "User B")).status, 200);
  assert.equal((await signup(tokenB, "User C")).status, 409);

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(response.status, 401);

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
    body: JSON.stringify({ password: "test-strong-password" })
  });
  assert.equal(response.status, 200);
  const { adminToken } = await readJson(response);
  const adminHeaders = { authorization: `Bearer ${adminToken}` };

  response = await runApi(onRequest, env, "/api/logs", { headers: adminHeaders });
  assert.ok((await readJson(response)).logs.length >= 3);

  response = await runApi(onRequest, env, "/api/settings", {
    method: "PUT",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({ mainTitle: "测试联赛", subTitle: "测试副标题" })
  });
  assert.equal(response.status, 200);

  response = await runApi(onRequest, env, "/api/ranks", {
    method: "PUT",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({ rankOptions: [{ value: "传奇", label: "传奇", color: "indigo" }] })
  });
  assert.equal(response.status, 200);

  response = await runApi(onRequest, env, "/api/clans/bingjingling", {
    method: "PUT",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      name: "冰精灵测试",
      tag: "#2QJPQ88LJ",
      rank: "水晶2",
      category: "水晶2",
      capacity: 30,
      time: "12月1号",
      requirement: "测试条件"
    })
  });
  assert.equal(response.status, 200);

  response = await runApi(onRequest, env, `/api/entries/${entryId}/move`, {
    method: "POST",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({ direction: "toSub" })
  });
  assert.equal(response.status, 200);

  response = await runApi(onRequest, env, "/api/reset", {
    method: "POST",
    headers: adminHeaders
  });
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).archived, true);

  response = await runApi(onRequest, env, "/api/archives", { headers: adminHeaders });
  const archives = (await readJson(response)).archives;
  assert.equal(archives.length, 1);

  response = await runApi(onRequest, env, `/api/archives/${archives[0].id}`, {
    headers: adminHeaders
  });
  assert.equal(response.status, 200);
  const archive = await readJson(response);
  assert.equal(archive.data.meta.mainTitle, "测试联赛");
  assert.equal(archive.data.clans.find(clan => clan.id === "bingjingling").name, "冰精灵测试");
  assert.ok(archive.data.clans.find(clan => clan.id === "xiyang").subs
    .some(entry => entry.id === entryId));

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await runApi(onRequest, env, "/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.2" },
      body: JSON.stringify({ password: "wrong-password" })
    });
  }
  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.2" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(response.status, 429);

  response = await runApi(onRequest, env, "/api/unknown");
  assert.equal(response.status, 404);
});

test("system preset entries are admin-only and admin session tokens are redacted from logs", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "preset-admin-password" };
  const publicState = await readJson(await runApi(onRequest, env, "/api/state"));
  const preset = publicState.clans[0].players[0];
  assert.equal(Object.hasOwn(preset, "ownerToken"), false);

  const deviceToken = (await readJson(await runApi(onRequest, env, "/api/device", {
    method: "POST"
  }))).deviceToken;
  const guestHeaders = { "content-type": "application/json", "x-device-token": deviceToken };
  let response = await runApi(onRequest, env, `/api/entries/${preset.id}`, {
    method: "PATCH",
    headers: guestHeaders,
    body: JSON.stringify({ name: "Unauthorized edit", th: "" })
  });
  assert.equal(response.status, 403);
  response = await runApi(onRequest, env, `/api/entries/${preset.id}`, {
    method: "DELETE",
    headers: { "x-device-token": deviceToken }
  });
  assert.equal(response.status, 403);

  const login = await readJson(await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD })
  }));
  const adminHeaders = { authorization: `Bearer ${login.adminToken}`, "content-type": "application/json" };
  response = await runApi(onRequest, env, `/api/entries/${preset.id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ name: "Admin maintained", th: "" })
  });
  assert.equal(response.status, 200);

  const adminState = await readJson(await runApi(onRequest, env, "/api/state?full=1", {
    headers: adminHeaders
  }));
  const updatedPreset = adminState.clans[0].players.find(entry => entry.id === preset.id);
  assert.equal(updatedPreset.ownerToken, "#SYS_PRESET");

  const storedLog = env.DB.prepare("SELECT token FROM logs ORDER BY id DESC LIMIT 1").first();
  assert.equal(storedLog.token, "#ADMIN");
  env.DB.prepare(
    "INSERT INTO logs(time, type, clan, details, operator, token) VALUES(?, 'EDIT', 'test', 'legacy log', '管理员', ?)"
  ).bind(Date.now(), login.adminToken).run();
  const logsResponse = await readJson(await runApi(onRequest, env, "/api/logs", {
    headers: { authorization: `Bearer ${login.adminToken}` }
  }));
  assert.ok(logsResponse.logs.some(log => log.token === "#ADMIN"));
  assert.equal(JSON.stringify(logsResponse).includes(login.adminToken), false);
});

test("admin log redaction migration scrubs previously stored session tokens", () => {
  const db = new TestD1();
  const oldSession = "a".repeat(48);
  db.prepare("INSERT INTO sessions(token, created_at, expires_at) VALUES(?, ?, ?)")
    .bind(oldSession, Date.now(), Date.now() + 60_000).run();
  db.prepare(
    "INSERT INTO logs(time, type, clan, details, operator, token) VALUES(?, 'EDIT', 'test', 'old admin action', '管理员', ?)"
  ).bind(Date.now(), oldSession).run();

  const migration = fs.readFileSync(
    path.join(__dirname, "../migrations/0003_redact_admin_session_logs.sql"),
    "utf8"
  );
  db.database.exec(migration);
  assert.equal(
    db.prepare("SELECT token FROM logs WHERE details = 'old admin action'").first().token,
    "#ADMIN"
  );
});

test("substitute capacity is enforced for signup and admin moves without exposing the cap", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "sub-capacity-password" };
  const deviceToken = (await readJson(await runApi(onRequest, env, "/api/device", {
    method: "POST"
  }))).deviceToken;
  const signupResponse = await runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": deviceToken },
    body: JSON.stringify({ clanId: "xiyang", name: "Main player", role: "main", th: "" })
  });
  assert.equal(signupResponse.status, 200);
  const { entryId } = await readJson(signupResponse);

  for (let index = 0; index < 30; index += 1) {
    env.DB.prepare(
      "INSERT INTO entries(id, clan_id, role, name, owner_token, created_at) VALUES(?, 'xiyang', 'sub', ?, ?, ?)"
    ).bind(`sub-cap-${index}`, `Sub ${index}`, deviceToken, Date.now() + index).run();
  }

  const login = await readJson(await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD })
  }));
  let response = await runApi(onRequest, env, `/api/entries/${entryId}/move`, {
    method: "POST",
    headers: { authorization: `Bearer ${login.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ direction: "toSub" })
  });
  assert.equal(response.status, 409);
  assert.equal((await readJson(response)).error, "sub_full");

  response = await runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": deviceToken },
    body: JSON.stringify({ clanId: "xiyang", name: "One too many", role: "sub", th: "" })
  });
  assert.equal(response.status, 409);
  const error = await readJson(response);
  assert.equal(error.error, "sub_full");
  assert.equal(error.message.includes("30"), false);
});

test("full state refresh returns owner tokens even when the revision is unchanged", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "full-state-test-password" };
  const deviceToken = (await readJson(await runApi(onRequest, env, "/api/device", {
    method: "POST"
  }))).deviceToken;
  const signupResponse = await runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": deviceToken },
    body: JSON.stringify({ clanId: "xiyang", name: "Full State User", role: "sub", th: "" })
  });
  assert.equal(signupResponse.status, 200);
  const { entryId } = await readJson(signupResponse);

  const publicState = await readJson(await runApi(onRequest, env, "/api/state"));
  const loginResponse = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD })
  });
  const { adminToken } = await readJson(loginResponse);
  const adminHeaders = { authorization: `Bearer ${adminToken}` };

  const staleResponse = await readJson(await runApi(
    onRequest, env, `/api/state?rev=${publicState.rev}`, { headers: adminHeaders }
  ));
  assert.equal(staleResponse.unchanged, true);

  const fullState = await readJson(await runApi(
    onRequest, env, `/api/state?full=1&rev=${publicState.rev}`, { headers: adminHeaders }
  ));
  const entry = fullState.clans.find(clan => clan.id === "xiyang")
    .subs.find(item => item.id === entryId);
  assert.equal(entry.ownerToken, deviceToken);
});

test("one-time admin setup stores a hash, consumes its code, and enables login", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1() };
  const setupCode = "a".repeat(64);
  const password = "safe-test-password-2026";
  await env.DB.prepare("INSERT INTO settings(key, value) VALUES('admin_setup_token', ?)")
    .bind(setupCode).run();

  let response = await runApi(onRequest, env, "/api/admin/setup/status");
  assert.deepEqual(await readJson(response), { available: true, tokenRequired: true });

  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.20" },
    body: JSON.stringify({ token: "b".repeat(64), password })
  });
  assert.equal(response.status, 403);

  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.20" },
    body: JSON.stringify({ token: setupCode, password })
  });
  assert.equal(response.status, 200);
  const setupResult = await readJson(response);
  assert.ok(setupResult.adminToken);

  const passwordRow = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'adminPasswordHash'"
  ).first();
  assert.match(passwordRow.value, /^10000\$/);
  assert.equal(passwordRow.value.includes(password), false);
  assert.equal(await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'admin_setup_token'"
  ).first(), null);
  response = await runApi(onRequest, env, "/api/admin/setup/status");
  assert.deepEqual(await readJson(response), { available: false, tokenRequired: false });

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.20" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(response.status, 401);

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.20" },
    body: JSON.stringify({ password })
  });
  assert.equal(response.status, 200);

  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.20" },
    body: JSON.stringify({ token: setupCode, password: "another-safe-password-2026" })
  });
  assert.equal(response.status, 409);
});

test("first-run admin setup fails closed until a one-time token is configured", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1() };
  const setupCode = "d".repeat(64);
  const password = "bootstrap-password-2026";

  let response = await runApi(onRequest, env, "/api/admin/setup/status");
  assert.deepEqual(await readJson(response), { available: true, tokenRequired: true });

  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.40" },
    body: JSON.stringify({ password })
  });
  assert.equal(response.status, 503);

  env.ADMIN_SETUP_TOKEN = setupCode;
  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.40" },
    body: JSON.stringify({ token: setupCode, password })
  });
  assert.equal(response.status, 200);
  assert.ok((await readJson(response)).adminToken);

  // Once configured, setup must be locked (409), and login with the new password works.
  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.40" },
    body: JSON.stringify({ password: "another-bootstrap-password-2026" })
  });
  assert.equal(response.status, 409);

  response = await runApi(onRequest, env, "/api/admin/setup/status");
  assert.deepEqual(await readJson(response), { available: false, tokenRequired: false });

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.40" },
    body: JSON.stringify({ password })
  });
  assert.equal(response.status, 200);
});

test("env ADMIN_SETUP_TOKEN is accepted as the one-time setup code", async () => {
  const { onRequest } = await import(workerUrl);
  const setupCode = "c".repeat(64);
  const env = { DB: new TestD1(), ADMIN_SETUP_TOKEN: setupCode };
  const password = "env-token-password-2026";

  let response = await runApi(onRequest, env, "/api/admin/setup/status");
  assert.deepEqual(await readJson(response), { available: true, tokenRequired: true });

  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.50" },
    body: JSON.stringify({ password })
  });
  assert.equal(response.status, 403);

  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.50" },
    body: JSON.stringify({ token: setupCode, password })
  });
  assert.equal(response.status, 200);
});

test("ADMIN_PASSWORD takes priority over a stale stored password hash", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "env-secret-password" };
  // Simulate a hash left in the database by an earlier one-time setup.
  const staleHash = `210000$${"ab".repeat(16)}$${"cd".repeat(32)}`;
  await env.DB.prepare("INSERT INTO settings(key, value) VALUES('adminPasswordHash', ?)")
    .bind(staleHash).run();

  let response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.30" },
    body: JSON.stringify({ password: "env-secret-password" })
  });
  assert.equal(response.status, 200);
  const { adminToken } = await readJson(response);
  assert.ok(adminToken);

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.30" },
    body: JSON.stringify({ password: "some-other-password" })
  });
  assert.equal(response.status, 401);

  response = await runApi(onRequest, env, "/api/admin/password", {
    method: "PUT",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      oldPassword: env.ADMIN_PASSWORD,
      newPassword: "replacement-secret-password"
    })
  });
  assert.equal(response.status, 409);
  assert.match((await readJson(response)).error, /ADMIN_PASSWORD Secret/);
});

test("no default admin password works when nothing is configured", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1() };

  const response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.60" },
    body: JSON.stringify({ password: "XXXX" })
  });
  assert.equal(response.status, 401);
  assert.deepEqual(
    await readJson(await runApi(onRequest, env, "/api/admin/setup/status")),
    { available: true, tokenRequired: true }
  );
});

test("admin can change the password via PUT /api/admin/password", async () => {
  const { onRequest } = await import(workerUrl);
  const setupCode = "e".repeat(64);
  const env = { DB: new TestD1(), ADMIN_SETUP_TOKEN: setupCode };
  const oldPassword = "initial-safe-password-2026";
  const newPassword = "my-new-strong-password-2026";

  let response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.70" },
    body: JSON.stringify({ token: setupCode, password: oldPassword })
  });
  assert.equal(response.status, 200);
  const { adminToken } = await readJson(response);
  const adminHeaders = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };

  // Wrong old password must be rejected.
  response = await runApi(onRequest, env, "/api/admin/password", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ oldPassword: "wrong", newPassword })
  });
  assert.equal(response.status, 401);

  // New password too short must be rejected.
  response = await runApi(onRequest, env, "/api/admin/password", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ oldPassword, newPassword: "short" })
  });
  assert.equal(response.status, 400);

  // Successful change.
  response = await runApi(onRequest, env, "/api/admin/password", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ oldPassword, newPassword })
  });
  assert.equal(response.status, 200);

  // The old password no longer works.
  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.70" },
    body: JSON.stringify({ password: oldPassword })
  });
  assert.equal(response.status, 401);

  // New password works.
  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.70" },
    body: JSON.stringify({ password: newPassword })
  });
  assert.equal(response.status, 200);
});

test("deleting an entry preserves the owner's device token in the audit log", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "delete-preserve-password" };

  const tokenA = (await readJson(await runApi(onRequest, env, "/api/device", {
    method: "POST"
  }))).deviceToken;

  let response = await runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": tokenA },
    body: JSON.stringify({ clanId: "xiyang", name: "Preserve Me", role: "main", th: "19本" })
  });
  assert.equal(response.status, 200);
  const entryId = (await readJson(response)).entryId;

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.80" },
    body: JSON.stringify({ password: "delete-preserve-password" })
  });
  assert.equal(response.status, 200);
  const adminHeaders = { authorization: `Bearer ${(await readJson(response)).adminToken}` };

  // Admin removes the signup; the entry is gone but its device token must survive in logs.
  response = await runApi(onRequest, env, `/api/entries/${entryId}`, {
    method: "DELETE",
    headers: adminHeaders
  });
  assert.equal(response.status, 200);

  response = await runApi(onRequest, env, "/api/state");
  const state = await readJson(response);
  assert.equal(state.clans.find(clan => clan.id === "xiyang")
    .players.some(entry => entry.id === entryId), false);

  response = await runApi(onRequest, env, "/api/logs", { headers: adminHeaders });
  const logs = (await readJson(response)).logs;
  const removal = logs.find(log => log.type === "REMOVE" && log.token === tokenA);
  assert.ok(removal, "REMOVE log should retain the owner's device token");
  assert.ok(removal.details.includes("Preserve Me"));
});

test("only service-issued or previously bound device tokens can sign up", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1() };

  // 格式非法的令牌（非 #U- 开头或含非法字符）必须被拒绝。
  let response = await runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": "not-a-token" },
    body: JSON.stringify({ clanId: "xiyang", name: "Bad", role: "main", th: "19本" })
  });
  assert.equal(response.status, 400);

  // 格式正确但未签发、也未绑定历史报名的令牌仍必须被拒绝。
  response = await runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": "#U-DEADBEEF" },
    body: JSON.stringify({ clanId: "xiyang", name: "AutoRegistered", role: "sub", th: "" })
  });
  assert.equal(response.status, 403);
  assert.equal(env.DB.prepare("SELECT token FROM device_tokens WHERE token = ?")
    .bind("#U-DEADBEEF").first(), null);

  // Migration-era tokens already attached to an entry remain valid.
  env.DB.prepare(
    "INSERT INTO entries(id, clan_id, role, name, owner_token, created_at) VALUES(?, ?, ?, ?, ?, ?)"
  ).bind("legacy-token-entry", "xiyang", "sub", "Legacy", "#U-LEGACY01", Date.now()).run();
  response = await runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": "#U-LEGACY01" },
    body: JSON.stringify({ clanId: "xiyang", name: "Legacy child", role: "sub", th: "" })
  });
  assert.equal(response.status, 200);

  // 服务端签发的令牌可以正常报名。
  const token = (await readJson(await runApi(onRequest, env, "/api/device", {
    method: "POST"
  }))).deviceToken;
  response = await runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-token": token },
    body: JSON.stringify({ clanId: "xiyang", name: "Legit", role: "main", th: "19本" })
  });
  assert.equal(response.status, 200);
});

test("signup is IP rate limited to block spamming", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1() };
  const token = (await readJson(await runApi(onRequest, env, "/api/device", {
    method: "POST"
  }))).deviceToken;
  const signup = () => runApi(onRequest, env, "/api/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      "x-device-token": token
    },
    body: JSON.stringify({ clanId: "bingjingling", name: "Rate", role: "sub", th: "" })
  });

  let last;
  for (let i = 0; i < 30; i += 1) last = await signup();
  assert.equal(last.status, 200, "前 30 次应放行");
  assert.equal((await signup()).status, 429, "第 31 次应被限速");
});

test("admin can view storage usage and set the server quota", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "storage-password-2026" };

  let response = await runApi(onRequest, env, "/api/admin/storage");
  assert.equal(response.status, 403);

  const login = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
    body: JSON.stringify({ password: "storage-password-2026" })
  });
  const adminHeaders = { authorization: `Bearer ${(await readJson(login)).adminToken}` };

  response = await runApi(onRequest, env, "/api/admin/storage", { headers: adminHeaders });
  assert.equal(response.status, 200);
  let stats = await readJson(response);
  assert.equal(stats.limitBytes, 500 * 1024 * 1024);
  assert.ok(stats.usedBytes > 0);
  assert.equal(stats.protectDays, 90);
  assert.equal(stats.counts.entries, 44);
  assert.ok(Array.isArray(stats.alerts));
  // 容量检测应覆盖「全部数据表」：逐表明细齐全，且条数正确。
  assert.ok(stats.tables, "应返回逐表明细");
  const tableKeys = Object.keys(stats.tables);
  for (const key of ["entries", "logs", "archives", "devices", "sessions", "loginAttempts", "rateLimits", "clans", "settings"]) {
    assert.ok(tableKeys.includes(key), `明细应包含 ${key}`);
    assert.ok(Number.isFinite(stats.tables[key].bytes), `${key} 应有字节估算`);
  }
  assert.equal(stats.tables.entries.count, 44);
  assert.equal(stats.tables.clans.count, 7);

  response = await runApi(onRequest, env, "/api/admin/storage", {
    method: "PUT",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({ limitMB: 10 })
  });
  assert.equal(response.status, 200);
  stats = await readJson(await runApi(onRequest, env, "/api/admin/storage", { headers: adminHeaders }));
  assert.equal(stats.limitBytes, 10 * 1024 * 1024);
});

test("capacity pruning deletes only records older than 3 months", async () => {
  const { onRequest } = await import(workerUrl);
  const env = {
    DB: new TestD1(),
    ADMIN_PASSWORD: "prune-password-2026",
    STORAGE_LIMIT_BYTES: String(80 * 1024)
  };
  // 塞入一批「3 个月前」的旧记录，把用量推到 50% 阈值以上。
  const old = Date.now() - 120 * 24 * 60 * 60 * 1000;
  const statements = [];
  for (let i = 0; i < 300; i += 1) {
    statements.push(env.DB.prepare(
      "INSERT INTO entries(id, clan_id, role, name, owner_token, created_at) " +
        "VALUES(?, 'xiyang', 'sub', ?, '#U-OLD', ?)"
    ).bind(`old_${i}`, `旧记录${i}`, old));
  }
  await env.DB.batch(statements);
  // 再放一条 3 个月内的新记录，它必须被永远保留。
  await env.DB.prepare(
    "INSERT INTO entries(id, clan_id, role, name, owner_token, created_at) " +
      "VALUES('new_keep', 'xiyang', 'sub', '保留', '#U-NEW', ?)"
  ).bind(Date.now()).run();

  const login = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
    body: JSON.stringify({ password: "prune-password-2026" })
  });
  const adminHeaders = { authorization: `Bearer ${(await readJson(login)).adminToken}` };

  const response = await runApi(onRequest, env, "/api/admin/storage/prune", {
    method: "POST",
    headers: adminHeaders
  });
  assert.equal(response.status, 200);
  const { report } = await readJson(response);
  assert.equal(report.triggered, true);
  assert.ok(report.deletedEntries > 0, "应删除超期的最旧记录");
  assert.ok(
    report.oldestDeletedAt < Date.now() - 90 * 24 * 60 * 60 * 1000,
    "删除的都应早于 3 个月保护期"
  );

  const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries WHERE id = 'new_keep'").first();
  assert.equal(kept.n, 1, "3 个月内的新记录必须保留");

  const tooRecent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM entries WHERE created_at >= ?"
  ).bind(Date.now() - 90 * 24 * 60 * 60 * 1000).first();
  assert.equal(tooRecent.n, 45, "保护期内的记录不应被删（44 条预置 + 1 条新记录）");
});

test("admin can batch import WeChat signups in the fixed format", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "import-password-2026" };

  // 未登录必须被拒绝。
  let response = await runApi(onRequest, env, "/api/admin/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "火焰部落 | 张三" })
  });
  assert.equal(response.status, 403);

  const login = await readJson(await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.30" },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD })
  }));
  const adminHeaders = {
    authorization: `Bearer ${login.adminToken}`,
    "content-type": "application/json"
  };

  // 错误方法应被拒绝。
  response = await runApi(onRequest, env, "/api/admin/import", { headers: adminHeaders });
  assert.equal(response.status, 405);

  // 混合格式：半角/全角分隔符、带本数与角色、未知部落、省略本数与角色。
  response = await runApi(onRequest, env, "/api/admin/import", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      text: [
        "火焰部落 | 张三 | 19本 | 正选",
        "飘雪城｜李四｜18本｜替补",
        "不存在的部落 | 王五",
        "雪精灵 | 赵六"
      ].join("\n")
    })
  });
  assert.equal(response.status, 200);
  const result = await readJson(response);
  assert.equal(result.added, 3);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].line, 3);
  assert.match(result.skipped[0].reason, /部落/);

  // 指定默认部落 + 默认角色时，行首可省略部落名。
  response = await runApi(onRequest, env, "/api/admin/import", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ clanId: "huoyan", role: "sub", text: "钱七 | 16本\n孙八" })
  });
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).added, 2);

  const state = await readJson(await runApi(onRequest, env, "/api/state?full=1", {
    headers: adminHeaders
  }));
  const huoyan = state.clans.find(clan => clan.id === "huoyan");
  const piaoxue = state.clans.find(clan => clan.id === "piaoxue");
  const xuejingling = state.clans.find(clan => clan.id === "xuejingling");
  const zhang = huoyan.players.find(entry => entry.text === "张三 19本");
  assert.ok(zhang, "带本数的正选应被写入对应部落");
  assert.equal(zhang.ownerToken, "#SYS_PRESET");
  assert.ok(piaoxue.subs.some(entry => entry.text === "李四 18本"));
  assert.ok(xuejingling.players.some(entry => entry.text === "赵六"));
  assert.ok(huoyan.subs.some(entry => entry.text === "钱七 16本"));
  assert.ok(huoyan.subs.some(entry => entry.text === "孙八"));

  // 满员时不应写入，并给出原因。
  const fill = [];
  for (let index = 0; index < 20; index += 1) {
    fill.push({ clanId: "xiyang", role: "main", text: `溢出${index}` });
  }
  response = await runApi(onRequest, env, "/api/admin/import", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ text: fill.map(line => line.clanId + " | " + line.text + " | main").join("\n") })
  });
  assert.equal(response.status, 200);
  const overflow = await readJson(response);
  assert.ok(overflow.added > 0);
  assert.ok(overflow.skipped.some(item => item.reason === "正选名额已满"));
});

test("admin can import a WeChat relay (接龙) paste directly", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1(), ADMIN_PASSWORD: "relay-password-2026" };

  const login = await readJson(await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.40" },
    body: JSON.stringify({ password: env.ADMIN_PASSWORD })
  }));
  const adminHeaders = {
    authorization: `Bearer ${login.adminToken}`,
    "content-type": "application/json"
  };

  // 同部落接龙：选了默认部落，接龙里只有序号 + 昵称 + 本数。
  const relay = [
    "#接龙",
    "火焰部落 联赛报名（正选）",
    "1. 张三 19本",
    "2. 李四 18本 替补",
    "3、王五",
    "4. Peace & Love 17本"
  ].join("\n");
  let response = await runApi(onRequest, env, "/api/admin/import", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ clanId: "huoyan", text: relay })
  });
  assert.equal(response.status, 200);
  const result = await readJson(response);
  assert.equal(result.added, 4, "标题行与 #接龙 应被忽略，四条报名全部写入");
  assert.equal(result.skipped.length, 0);

  const state = await readJson(await runApi(onRequest, env, "/api/state?full=1", {
    headers: adminHeaders
  }));
  const huoyan = state.clans.find(clan => clan.id === "huoyan");
  assert.ok(huoyan.players.some(entry => entry.text === "张三 19本"));
  assert.ok(huoyan.players.some(entry => entry.text === "王五"), "无本数的接龙条目也应写入");
  assert.ok(huoyan.players.some(entry => entry.text === "Peace & Love 17本"), "含空格的昵称应完整保留");
  assert.ok(huoyan.subs.some(entry => entry.text === "李四 18本"), "接龙里标注的替补应进入替补席");

  // 跨部落接龙：不选默认部落，靠标题行 / 行首部落名识别。
  const crossRelay = [
    "#接龙",
    "联赛报名",
    "1. 夕阳之秋 赵六 16本",
    "2. 雪精灵 孙七 15本及以下"
  ].join("\n");
  response = await runApi(onRequest, env, "/api/admin/import", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ text: crossRelay })
  });
  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).added, 2);

  const state2 = await readJson(await runApi(onRequest, env, "/api/state?full=1", {
    headers: adminHeaders
  }));
  assert.ok(state2.clans.find(clan => clan.id === "xiyang").players.some(entry => entry.text === "赵六 16本"));
  assert.ok(state2.clans.find(clan => clan.id === "xuejingling").players.some(entry => entry.text === "孙七 15本及以下"));
});
