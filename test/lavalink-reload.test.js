const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const readSource = (file) => fs.readFileSync(path.join(root, file), "utf8");
const commandSource = readSource("commands/slash/lavalink.js");
const reloadSource = commandSource.match(
  /async function reloadNodes\(client, reportProgress\) \{[\s\S]*?\n\}/
)?.[0];
assert.ok(
  reloadSource,
  "The tests must exercise the actual reloadNodes function"
);

const translate = (key, values) => (values ? { key, ...values } : key);
const plain = (value) => JSON.parse(JSON.stringify(value));
const recoveryModule = { exports: {} };
vm.runInNewContext(readSource("util/playerRecovery.js"), {
  module: recoveryModule,
  require: () => ({ EmbedBuilder: class {} }),
});

function createHarness({
  heroku = true,
  localConfig,
  devConfig,
  persistedNodes = null,
  databaseError = null,
  players = [],
  recoveryError = null,
} = {}) {
  // A virtual /app and synthetic Config Vars avoid reading real local secrets,
  // contacting Discord/MongoDB, or changing the process environment.
  const env = heroku
    ? {
        DYNO: "worker.1",
        BOT_ADMIN_ID: "test-admin",
        DISCORD_TOKEN: "test-token",
        DISCORD_CLIENT_ID: "test-client",
        MONGODB_URI: "mongodb://test.invalid/music",
        LAVALINK_HOST: "test-node.invalid",
        LAVALINK_PASSWORD: "test-password",
        LAVALINK_PORT: "443",
        LAVALINK_SECURE: "true",
      }
    : {};
  const files = new Map([
    ["/app/util/getConfig.js", readSource("util/getConfig.js")],
    ["/app/config.heroku.js", readSource("config.heroku.js")],
    [
      "/app/config_example.js",
      () => ({ embedColor: "#abcdef12", serverDeafen: true, nodes: [] }),
    ],
  ]);
  if (localConfig) files.set("/app/config.js", () => plain(localConfig));
  if (devConfig) files.set("/app/dev-config.js", () => plain(devConfig));
  const cache = {};

  function resolveModule(id, parent) {
    const file = `${path.posix
      .resolve(path.posix.dirname(parent), id)
      .replace(/\.js$/, "")}.js`;
    if (!files.has(file)) {
      const error = new Error(`Cannot find module '${file}'`);
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return file;
  }

  function makeRequire(parent) {
    const request = (id) => {
      if (id === "dotenv") return { config: () => ({}) };
      if (id === "./i18n") return { t: translate };
      return loadModule(resolveModule(id, parent));
    };
    request.resolve = (id) => resolveModule(id, parent);
    request.cache = cache;
    return request;
  }

  function loadModule(file) {
    if (cache[file]) return cache[file].exports;
    const loaded = { exports: {} };
    cache[file] = loaded;
    try {
      const source = files.get(file);
      if (typeof source === "function") {
        loaded.exports = source();
      } else {
        vm.runInNewContext(
          source,
          {
            module: loaded,
            require: makeRequire(file),
            process: { env },
            // CommonJS modules share one Error constructor in a real process.
            Error,
          },
          { filename: file }
        );
      }
      return loaded.exports;
    } catch (error) {
      delete cache[file];
      throw error;
    }
  }

  const calls = {
    dbReads: 0,
    disconnects: 0,
    restored: [],
    notices: [],
    warnings: [],
  };
  const nodes = new Map();
  const client = {
    config: { embedColor: "#123456", nodes: [{ id: "old-node" }] },
    user: { id: "bot", username: "Test Bot" },
    lavalinkNotified: new Set(["old-node"]),
    async getPersistedLavalinkNodes() {
      calls.dbReads += 1;
      if (databaseError) throw databaseError;
      return persistedNodes === null ? null : plain(persistedNodes);
    },
    warn: (message) => calls.warnings.push(message),
    manager: {
      options: {},
      players: new Map(players.map((player) => [player.guildId, player])),
      nodeManager: {
        nodes,
        async disconnectAll() {
          calls.disconnects += 1;
          nodes.clear();
        },
        createNode: (node) => nodes.set(node.id, node),
        connectAll: async () => [...nodes.values()],
      },
    },
  };
  const context = vm.createContext({
    __dirname: "/app/commands/slash",
    path: path.posix,
    fs: { existsSync: (file) => files.has(file) },
    require: makeRequire("/app/commands/slash/lavalink.js"),
    t: translate,
    buildInfoEmbed: (_client, color, message) => ({ color, message }),
    createPlayerRecoverySnapshots:
      recoveryModule.exports.createPlayerRecoverySnapshots,
    async restoreRecoveredPlayer(_client, snapshot) {
      if (recoveryError) throw recoveryError;
      calls.restored.push(plain(snapshot));
    },
    async sendRecoveryNotice(_client, snapshot, key) {
      calls.notices.push({ guildId: snapshot.guildId, key });
    },
  });
  vm.runInContext(reloadSource, context);
  return {
    client,
    calls,
    env,
    files,
    loadConfig: () => loadModule("/app/util/getConfig.js")(),
    reload: () => context.reloadNodes(client, async () => {}),
  };
}

test("Heroku reload works without config.js or dev-config.js", async () => {
  const h = createHarness();
  const result = await h.reload();
  assert.equal(result.message.key, "lavalink.reloadSuccess");
  assert.equal(h.client.config.nodes[0].host, "test-node.invalid");
  assert.equal(h.client.config.nodes[0].secure, true);
  assert.equal(h.client.config.embedColor, "#abcdef");
  assert.equal(h.calls.disconnects, 1);
  assert.equal(h.client.isLavalinkReloading, false);
});

test("reload invalidates cached Heroku config and reads current Config Vars", async () => {
  const h = createHarness();
  const initial = await h.loadConfig();
  h.env.LAVALINK_HOST = "updated-node.invalid";
  h.env.LAVALINK_PORT = "3333";
  h.env.LAVALINK_SECURE = "false";
  assert.equal((await h.loadConfig()).nodes[0].host, initial.nodes[0].host);
  await h.reload();
  assert.equal(h.client.config.nodes[0].host, "updated-node.invalid");
  assert.equal(h.client.config.nodes[0].port, 3333);
  assert.equal(h.client.config.nodes[0].secure, false);
});

test("local config still reloads without Heroku environment variables", async () => {
  const h = createHarness({
    heroku: false,
    localConfig: { embedColor: "#123456", nodes: [{ id: "local-node" }] },
  });
  await h.loadConfig();
  h.files.set("/app/config.js", () => ({ nodes: [{ id: "updated-local" }] }));
  const result = await h.reload();
  assert.equal(result.message.key, "lavalink.reloadSuccess");
  assert.equal(h.client.config.nodes[0].id, "updated-local");
});

test("dev-config keeps precedence over local and Heroku config", async () => {
  const h = createHarness({
    localConfig: { nodes: [{ id: "local-node" }] },
    devConfig: { nodes: [{ id: "dev-node" }] },
  });
  await h.loadConfig();
  h.files.set("/app/dev-config.js", () => ({ nodes: [{ id: "updated-dev" }] }));
  await h.reload();
  assert.equal(h.client.config.nodes[0].id, "updated-dev");
});

test("database nodes and their enabled flags override Config Vars", async () => {
  const saved = [
    { id: "node0", host: "saved.invalid", enabled: true },
    { id: "node1", host: "disabled.invalid", enabled: false },
  ];
  const h = createHarness({ persistedNodes: saved });
  await h.reload();
  assert.deepEqual(plain(h.client.config.nodes), saved);
  assert.deepEqual(plain(h.client.manager.options.nodes), saved);
  assert.equal(h.calls.dbReads, 1);
});

test("an empty database node list remains authoritative", async () => {
  const h = createHarness({ persistedNodes: [] });
  await h.reload();
  assert.deepEqual(plain(h.client.config.nodes), []);
  assert.equal(h.client.manager.nodeManager.nodes.size, 0);
});

test("missing Heroku Config Vars report their error without disconnecting nodes", async () => {
  const h = createHarness();
  delete h.env.LAVALINK_HOST;
  const result = await h.reload();
  assert.equal(result.message.key, "lavalink.reloadError");
  assert.match(
    result.message.error,
    /Missing required Config Var: LAVALINK_HOST/
  );
  assert.equal(h.calls.dbReads, 0);
  assert.equal(h.calls.disconnects, 0);
  assert.equal(h.client.isLavalinkReloading, false);
});

test("database failure reports an error before touching existing players", async () => {
  const h = createHarness({ databaseError: new Error("Database unavailable") });
  const result = await h.reload();
  assert.equal(result.message.error, "Database unavailable");
  assert.equal(h.calls.disconnects, 0);
  assert.equal(h.client.config.nodes[0].id, "old-node");
  assert.equal(h.client.isLavalinkReloading, false);
});

function makePlayer(guildId, paused = false) {
  return {
    guildId,
    voiceChannelId: `voice-${guildId}`,
    textChannelId: `text-${guildId}`,
    playing: true,
    paused,
    queue: {
      current: {
        info: {
          uri: "https://example.invalid/song",
          title: "Song",
          author: "Artist",
        },
      },
      tracks: [{ info: { title: "Do not restore queued songs" } }],
    },
    get: () => null,
    destroy: async () => {},
  };
}

test("playing song and channel IDs are retained, while paused players are skipped", async () => {
  const h = createHarness({
    players: [makePlayer("active"), makePlayer("paused", true)],
  });
  const result = await h.reload();
  assert.equal(result.message.recoverable, 1);
  assert.equal(result.message.restored, 1);
  assert.equal(h.calls.restored[0].guildId, "active");
  assert.equal(h.calls.restored[0].voiceChannelId, "voice-active");
  assert.equal(h.calls.restored[0].textChannelId, "text-active");
  assert.equal(h.calls.restored[0].query, "https://example.invalid/song");
  assert.equal(h.calls.restored[0].tracks, undefined);
  assert.equal(h.calls.notices[0].key, "error.musicRestored");
});

test("player recovery failure is reported and the reload flag is reset", async () => {
  const h = createHarness({
    players: [makePlayer("active")],
    recoveryError: new Error("Track unavailable"),
  });
  const result = await h.reload();
  assert.equal(result.message.restored, 0);
  assert.equal(h.calls.notices[0].key, "error.musicRestoreFailed");
  assert.match(h.calls.warnings[0], /Track unavailable/);
  assert.equal(h.client.isLavalinkReloading, false);
});
