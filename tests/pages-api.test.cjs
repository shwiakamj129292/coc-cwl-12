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
    const migration = fs.readFileSync(
      path.join(__dirname, "../migrations/0001_init.sql"),
      "utf8"
    );
    this.database.exec(migration);
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

async function readJson(response) {
  return response.json();
}

async function runApi(onRequest, env, route, options = {}) {
  const request = new Request(`https://signup.test${route}`, options);
  return onRequest({ request, env });
}

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
  assert.match(passwordRow.value, /^210000\$/);
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

test("first-run bootstrap lets an admin set a password with no token", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1() };
  const password = "bootstrap-password-2026";

  let response = await runApi(onRequest, env, "/api/admin/setup/status");
  assert.deepEqual(await readJson(response), { available: true, tokenRequired: false });

  // No token provided on purpose — first-run bootstrap must accept it.
  response = await runApi(onRequest, env, "/api/admin/setup", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.40" },
    body: JSON.stringify({ password })
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
  assert.ok((await readJson(response)).adminToken);

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.30" },
    body: JSON.stringify({ password: "some-other-password" })
  });
  assert.equal(response.status, 401);
});

test("default admin password 0921 works when nothing is configured", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1() };

  let response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.60" },
    body: JSON.stringify({ password: "0921" })
  });
  assert.equal(response.status, 200);
  assert.ok((await readJson(response)).adminToken);

  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.60" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(response.status, 401);
});

test("admin can change the password via PUT /api/admin/password", async () => {
  const { onRequest } = await import(workerUrl);
  const env = { DB: new TestD1() };
  const newPassword = "my-new-strong-password-2026";

  // Login with the default password first.
  let response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.70" },
    body: JSON.stringify({ password: "0921" })
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
    body: JSON.stringify({ oldPassword: "0921", newPassword: "short" })
  });
  assert.equal(response.status, 400);

  // Successful change.
  response = await runApi(onRequest, env, "/api/admin/password", {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ oldPassword: "0921", newPassword })
  });
  assert.equal(response.status, 200);

  // Old default password no longer works.
  response = await runApi(onRequest, env, "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.70" },
    body: JSON.stringify({ password: "0921" })
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
