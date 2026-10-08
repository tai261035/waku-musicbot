const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const SlashCommand = require("../../lib/SlashCommand");
const { t } = require("../../util/i18n");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  createPlayerRecoverySnapshots,
  restoreRecoveredPlayer,
  sendRecoveryNotice,
} = require("../../util/playerRecovery");

const MAX_NODES = 10;
const SUBMENU_TIMEOUT = 60_000;
const MODAL_TIMEOUT = 120_000;
const NODE_TEST_TIMEOUT_MS = 25_000;
const NODE_TEST_ATTEMPTS = 2;
const testedNodeSessions = new Map();

function getBoolean(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function isNodeEnabled(node) {
  return node?.enabled !== false;
}

function getConfiguredNodes(client) {
  return (client.config.nodes || []).map((node) => ({
    ...node,
    enabled: isNodeEnabled(node),
  }));
}

function getNodePassword(node) {
  return node.authorization || node.password || "";
}

function findNextNodeId(nodes) {
  for (let index = 1; index < MAX_NODES; index += 1) {
    const id = `node${index}`;
    if (!nodes.some((node) => node.id === id)) return id;
  }
  return null;
}

async function pingNode(host, port, password, secure) {
  const protocol = secure ? "https" : "http";
  const startedAt = Date.now();
  const endpoint = `${protocol}://${host}:${port}/v4/info`;
  let lastError = null;

  for (let attempt = 1; attempt <= NODE_TEST_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      NODE_TEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(endpoint, {
        headers: {
          Authorization: password,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}`,
        };
      }

      return {
        success: true,
        data: await response.json(),
        latency: Date.now() - startedAt,
      };
    } catch (error) {
      lastError =
        error?.name === "AbortError"
          ? new Error(
              `Connection timed out after ${NODE_TEST_TIMEOUT_MS / 1000}s`
            )
          : error;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < NODE_TEST_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  return {
    success: false,
    error: lastError?.message || "Could not reach Lavalink.",
  };
}

function parseNodeInput(value) {
  const parts = String(value || "")
    .trim()
    .split(":");
  if (parts.length !== 4) throw new Error(t("lavalink.formatInvalid"));

  const [host, rawPort, password, rawSecure] = parts.map((part) => part.trim());
  const port = Number(rawPort);
  const secure = rawSecure.toLowerCase();
  if (
    !host ||
    !/^[a-zA-Z0-9.-]+$/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !password ||
    !["true", "false"].includes(secure)
  ) {
    throw new Error(t("lavalink.formatInvalid"));
  }

  return {
    host,
    port,
    password,
    secure: secure === "true",
  };
}

function createNodeConfig(id, input, enabled = true) {
  return {
    id,
    host: input.host,
    port: input.port,
    authorization: input.password,
    retryAmount: 200,
    retryDelay: 40,
    secure: input.secure,
    requestTimeout: 60000,
    enabled,
  };
}

function buildMainEmbed(client) {
  const nodes = getConfiguredNodes(client);
  const liveNodes = client.manager.nodeManager.nodes;
  const lines = nodes.map((node) => {
    const liveNode = liveNodes.get(node.id);
    const status = liveNode?.connected ? "🟢" : "🔴";
    return t("lavalink.nodeLine", {
      status,
      id: node.id,
      host: node.host,
      port: node.port,
      password: getNodePassword(node),
      secure: getBoolean(node.secure) ? "true" : "false",
    });
  });

  return new EmbedBuilder()
    .setColor(client.config.embedColor)
    .setTitle(t("lavalink.menuTitle"))
    .setDescription(lines.length > 0 ? lines.join("\n") : t("lavalink.noNodes"))
    .setTimestamp();
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function buildMainComponents(client) {
  const nodes = getConfiguredNodes(client);
  const nodeRows = chunk(
    nodes.map((node) =>
      new ButtonBuilder()
        .setCustomId(`lava:toggle:${node.id}`)
        .setLabel(node.id)
        .setStyle(
          isNodeEnabled(node) ? ButtonStyle.Success : ButtonStyle.Danger
        )
    ),
    5
  ).map((buttons) => new ActionRowBuilder().addComponents(buttons));

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("lava:action:add")
      .setLabel(t("lavalink.actionAdd"))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("lava:action:remove")
      .setLabel(t("lavalink.actionRemove"))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("lava:action:replace")
      .setLabel(t("lavalink.actionReplace"))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("lava:action:test")
      .setLabel(t("lavalink.actionTest"))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("lava:action:reload")
      .setLabel(t("lavalink.actionReload"))
      .setStyle(ButtonStyle.Primary)
  );

  return [...nodeRows, actionRow];
}

async function refreshMainMenu(client, mainInteraction) {
  await mainInteraction.editReply({
    embeds: [buildMainEmbed(client)],
    components: buildMainComponents(client),
  });
}

function buildInfoEmbed(client, color, description) {
  return new EmbedBuilder()
    .setColor(color || client.config.embedColor)
    .setDescription(description);
}

async function notifyLavalinkChange(client, color, description) {
  if (!client.sendLavalinkNotification) return;
  await client
    .sendLavalinkNotification(buildInfoEmbed(client, color, description))
    .catch(() => {});
}

async function destroyPlayersOnNode(client, nodeId, messageKey) {
  const players = [...client.manager.players.values()].filter(
    (player) => player.node?.id?.toLowerCase() === nodeId.toLowerCase()
  );

  for (const player of players) {
    try {
      const nowPlayingMessage = player.get("nowPlayingMessage");
      if (nowPlayingMessage) await nowPlayingMessage.delete().catch(() => {});

      const textChannel = client.channels.cache.get(player.textChannelId);
      if (textChannel) {
        await textChannel
          .send({
            embeds: [
              buildInfoEmbed(client, "#FF8800", t(messageKey)).setTimestamp(),
            ],
          })
          .catch(() => {});
      }
      await player.destroy().catch(() => {});
    } catch {}
  }

  return players.length;
}

async function destroyLiveNode(client, nodeId) {
  const liveNode = client.manager.nodeManager.nodes.get(nodeId);
  if (!liveNode) return;

  try {
    await liveNode.destroy();
  } catch {
    client.manager.nodeManager.nodes.delete(nodeId);
  }
}

async function addNode(client, input, reportProgress) {
  const nodes = getConfiguredNodes(client);
  if (nodes.length >= MAX_NODES) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.maxNodes", { max: MAX_NODES })
    );
  }
  if (
    nodes.some(
      (node) => node.host === input.host && Number(node.port) === input.port
    )
  ) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.nodeExists", {
        host: input.host,
        port: input.port,
      })
    );
  }

  await reportProgress(
    buildInfoEmbed(
      client,
      "#FFAA00",
      t("lavalink.testingBeforeAdd", {
        host: input.host,
        port: input.port,
      })
    )
  );
  const test = await pingNode(
    input.host,
    input.port,
    input.password,
    input.secure
  );
  if (!test.success) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.cannotConnectAdd", {
        host: input.host,
        port: input.port,
        error: test.error,
      })
    );
  }

  const id = findNextNodeId(nodes);
  if (!id)
    return buildInfoEmbed(client, "#FF0000", t("lavalink.noSlotAvailable"));

  const node = createNodeConfig(id, input);
  nodes.push(node);
  try {
    await client.saveLavalinkNodes(nodes);
    client.manager.options.nodes = nodes;
    client.manager.nodeManager.createNode(node);
    await client.manager.nodeManager.connectAll();
    client.lavalinkNotified?.delete(id);
  } catch (error) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.errorGeneric", { error: error.message })
    );
  }

  await notifyLavalinkChange(
    client,
    "#00FF00",
    t("lavalink.addedNotify", {
      id,
      host: input.host,
      port: input.port,
      count: nodes.length,
    })
  );
  return buildInfoEmbed(
    client,
    "#00FF00",
    t("lavalink.nodeAdded", {
      id,
      host: input.host,
      port: input.port,
      secure: input.secure ? "true" : "false",
      latency: test.latency,
      count: nodes.length,
      max: MAX_NODES,
    })
  );
}

async function testNode(client, input, reportProgress) {
  const protocol = input.secure ? "https" : "http";
  await reportProgress(
    buildInfoEmbed(
      client,
      "#FFAA00",
      t("lavalink.pinging", {
        url: `${protocol}://${input.host}:${input.port}`,
      })
    )
  );

  const test = await pingNode(
    input.host,
    input.port,
    input.password,
    input.secure
  );
  if (!test.success) {
    return {
      success: false,
      embed: buildInfoEmbed(
        client,
        "#FF0000",
        t("lavalink.cannotConnect", {
          host: input.host,
          port: input.port,
          error: test.error,
        })
      ),
    };
  }

  return {
    success: true,
    embed: buildInfoEmbed(
      client,
      "#00FF00",
      t("lavalink.onlineResult", {
        host: input.host,
        port: input.port,
        secure: input.secure ? "true" : "false",
        version: test.data.version?.semver || t("lavalink.notAvailable"),
        latency: test.latency,
        sources:
          test.data.sourceManagers?.join(", ") || t("lavalink.notAvailable"),
      })
    ),
  };
}

function rememberTestedNode(input, userId, mainInteraction) {
  const token = randomUUID();
  testedNodeSessions.set(token, {
    input,
    userId,
    mainInteraction,
  });
  return token;
}

async function offerTestedNodeAdd(client, submission, input, mainInteraction) {
  const token = rememberTestedNode(input, submission.user.id, mainInteraction);
  await submission.editReply({
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`lava:add-tested:${token}`)
          .setLabel(t("lavalink.addBtn"))
          .setStyle(ButtonStyle.Success)
      ),
    ],
  });

  const resultMessage = await submission.fetchReply().catch(() => null);
  if (!resultMessage) {
    testedNodeSessions.delete(token);
    return;
  }

  const collector = resultMessage.createMessageComponentCollector({
    time: SUBMENU_TIMEOUT,
    filter: (button) =>
      button.user.id === submission.user.id &&
      button.customId === `lava:add-tested:${token}`,
  });

  collector.on("collect", async (button) => {
    collector.stop("added");
    const saved = testedNodeSessions.get(token);
    testedNodeSessions.delete(token);
    if (!saved || saved.userId !== button.user.id) return;

    await button.deferUpdate().catch(() => {});
    const reportProgress = (embed) =>
      submission.editReply({ embeds: [embed], components: [] }).catch(() => {});
    const result = await addNode(client, saved.input, reportProgress);
    await submission
      .editReply({ embeds: [result], components: [] })
      .catch(() => {});
    await refreshMainMenu(client, saved.mainInteraction).catch(() => {});
  });

  collector.on("end", (_collected, reason) => {
    testedNodeSessions.delete(token);
    if (reason === "time")
      submission.editReply({ components: [] }).catch(() => {});
  });
}

async function removeNode(client, nodeId) {
  if (nodeId.toLowerCase() === "node0") {
    return buildInfoEmbed(client, "#FF0000", t("lavalink.cannotRemoveNode0"));
  }

  const nodes = getConfiguredNodes(client);
  const index = nodes.findIndex(
    (node) => node.id.toLowerCase() === nodeId.toLowerCase()
  );
  if (index === -1) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.nodeNotFound", {
        id: nodeId,
        available: nodes.map((node) => `\`${node.id}\``).join(", "),
      })
    );
  }

  const node = nodes[index];
  const affectedPlayers = await destroyPlayersOnNode(
    client,
    node.id,
    "error.botUpdated"
  );
  try {
    await destroyLiveNode(client, node.id);
    nodes.splice(index, 1);
    await client.saveLavalinkNodes(nodes);
    client.manager.options.nodes = nodes;
    client.lavalinkNotified?.delete(node.id);
  } catch (error) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.errorGeneric", { error: error.message })
    );
  }

  await notifyLavalinkChange(
    client,
    "#FF0000",
    t("lavalink.removedNotify", {
      id: node.id,
      host: node.host,
      port: node.port,
      count: nodes.length,
    })
  );
  return buildInfoEmbed(
    client,
    "#00FF00",
    t("lavalink.nodeRemoved", {
      id: node.id,
      host: node.host,
      port: node.port,
      affected: affectedPlayers,
      count: nodes.length,
      max: MAX_NODES,
    })
  );
}

async function replaceNode(client, nodeId, input, reportProgress) {
  const nodes = getConfiguredNodes(client);
  const index = nodes.findIndex(
    (node) => node.id.toLowerCase() === nodeId.toLowerCase()
  );
  if (index === -1) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.nodeNotFound", {
        id: nodeId,
        available: nodes.map((node) => `\`${node.id}\``).join(", "),
      })
    );
  }

  const oldNode = nodes[index];
  await reportProgress(
    buildInfoEmbed(
      client,
      "#FFAA00",
      t("lavalink.testingBeforeReplace", {
        host: input.host,
        port: input.port,
        id: oldNode.id,
      })
    )
  );
  const test = await pingNode(
    input.host,
    input.port,
    input.password,
    input.secure
  );
  if (!test.success) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.cannotConnectReplace", {
        host: input.host,
        port: input.port,
        error: test.error,
        id: oldNode.id,
      })
    );
  }

  const affectedPlayers = await destroyPlayersOnNode(
    client,
    oldNode.id,
    "error.serverReplaced"
  );
  const newNode = createNodeConfig(oldNode.id, input, isNodeEnabled(oldNode));
  try {
    await destroyLiveNode(client, oldNode.id);
    nodes[index] = newNode;
    await client.saveLavalinkNodes(nodes);
    client.manager.options.nodes = nodes;
    client.manager.nodeManager.createNode(newNode);
    await client.manager.nodeManager.connectAll();
    client.lavalinkNotified?.delete(oldNode.id);
  } catch (error) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.errorGeneric", { error: error.message })
    );
  }

  await notifyLavalinkChange(
    client,
    "#00AAFF",
    t("lavalink.replacedNotify", {
      id: oldNode.id,
      oldHost: oldNode.host,
      oldPort: oldNode.port,
      host: input.host,
      port: input.port,
    })
  );
  return buildInfoEmbed(
    client,
    "#00FF00",
    t("lavalink.nodeReplaced", {
      id: oldNode.id,
      oldHost: oldNode.host,
      oldPort: oldNode.port,
      host: input.host,
      port: input.port,
      secure: input.secure ? "true" : "false",
      latency: test.latency,
      affected: affectedPlayers,
    })
  );
}

async function reloadNodes(client, reportProgress) {
  client.isLavalinkReloading = true;
  try {
    const root = path.resolve(__dirname, "..", "..");
    for (const filename of ["dev-config.js", "config.js", "config.heroku.js"]) {
      const candidate = path.join(root, filename);
      if (!fs.existsSync(candidate)) continue;
      delete require.cache[require.resolve(candidate)];
    }

    // Use the startup loader so Heroku can reload Config Vars without config.js.
    const configLoaderPath = require.resolve("../../util/getConfig");
    delete require.cache[configLoaderPath];
    const getConfig = require("../../util/getConfig");
    let newConfig = await getConfig();
    const persistedNodes = await client.getPersistedLavalinkNodes();
    if (persistedNodes !== null) {
      newConfig = {
        ...newConfig,
        nodes: persistedNodes,
      };
    }

    const oldNodes = client.config.nodes || [];
    const newNodes = newConfig.nodes || [];
    const changed = JSON.stringify(oldNodes) !== JSON.stringify(newNodes);
    const changeText = changed
      ? t("lavalink.nodesChanged")
      : t("lavalink.nodesUnchanged", { count: newNodes.length });
    await reportProgress(
      buildInfoEmbed(
        client,
        "#FFAA00",
        t("lavalink.reloadingConfig", {
          changes: changeText,
        })
      )
    );

    const activePlayers = [...client.manager.players.values()];
    const reloadSnapshots = createPlayerRecoverySnapshots(client, activePlayers);
    try {
      await client.manager.nodeManager.disconnectAll(true, false);
    } catch {
      client.manager.nodeManager.nodes.clear();
    }

    client.config = newConfig;
    client.manager.options.nodes = newNodes;
    client.lavalinkNotified?.clear();
    for (const node of newNodes) {
      client.manager.nodeManager.createNode(node);
    }
    const connected = await client.manager.nodeManager.connectAll();

    for (const player of activePlayers) {
      try {
        const nowPlayingMessage = player.get("nowPlayingMessage");
        if (nowPlayingMessage) await nowPlayingMessage.delete().catch(() => {});
        await player.destroy().catch(() => {});
      } catch {}
    }

    let restoredPlayers = 0;
    for (const snapshot of reloadSnapshots) {
      try {
        await restoreRecoveredPlayer(client, snapshot);
        restoredPlayers += 1;
        await sendRecoveryNotice(client, snapshot, "error.musicRestored");
      } catch (error) {
        client.warn(
          `Could not restore player for guild ${snapshot.guildId}: ${error.message}`
        );
        await sendRecoveryNotice(
          client,
          snapshot,
          "error.musicRestoreFailed"
        );
      }
    }

    const connectedCount = Array.isArray(connected)
      ? connected.length
      : connected;
    return buildInfoEmbed(
      client,
      "#00FF00",
      t("lavalink.reloadSuccess", {
        connected: connectedCount,
        count: activePlayers.length,
        restored: restoredPlayers,
        recoverable: reloadSnapshots.length,
      })
    );
  } catch (error) {
    return buildInfoEmbed(
      client,
      "#FF0000",
      t("lavalink.reloadError", { error: error?.message || String(error) })
    );
  } finally {
    client.isLavalinkReloading = false;
  }
}

function buildNodePickerComponents(nodes, action) {
  return chunk(
    nodes.map((node) =>
      new ButtonBuilder()
        .setCustomId(`lava:pick:${action}:${node.id}`)
        .setLabel(node.id)
        .setStyle(
          action === "remove" ? ButtonStyle.Danger : ButtonStyle.Primary
        )
    ),
    5
  ).map((buttons) => new ActionRowBuilder().addComponents(buttons));
}

async function openRemoveConfirmation(client, button, node, mainInteraction) {
  await button.reply({
    ephemeral: true,
    embeds: [
      buildInfoEmbed(
        client,
        "#FFAA00",
        t("lavalink.removeConfirm", { id: node.id })
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`lava:confirm-remove:${node.id}`)
          .setLabel(t("lavalink.removeConfirmButton", { id: node.id }))
          .setStyle(ButtonStyle.Danger)
      ),
    ],
  });

  const confirmationMessage = await button.fetchReply().catch(() => null);
  if (!confirmationMessage) return;
  const collector = confirmationMessage.createMessageComponentCollector({
    time: SUBMENU_TIMEOUT,
    filter: (confirmation) =>
      confirmation.user.id === button.user.id &&
      confirmation.customId === `lava:confirm-remove:${node.id}`,
  });

  collector.on("collect", async (confirmation) => {
    collector.stop("confirmed");
    await confirmation
      .update({
        embeds: [
          buildInfoEmbed(
            client,
            "#FFAA00",
            t("lavalink.removingNode", { id: node.id })
          ),
        ],
        components: [],
      })
      .catch(() => {});
    const result = await removeNode(client, node.id);
    await confirmationMessage
      .edit({ embeds: [result], components: [] })
      .catch(() => {});
    await refreshMainMenu(client, mainInteraction).catch(() => {});
  });

  collector.on("end", (_collected, reason) => {
    if (reason === "time") button.deleteReply().catch(() => {});
  });
}

async function openNodePicker(client, button, action, mainInteraction) {
  const nodes = getConfiguredNodes(client).filter(
    (node) => action !== "remove" || node.id.toLowerCase() !== "node0"
  );
  if (nodes.length === 0) {
    return button.reply({
      embeds: [
        buildInfoEmbed(client, "#FF0000", t("lavalink.noRemovableNodes")),
      ],
      ephemeral: true,
    });
  }

  await button.reply({
    ephemeral: true,
    embeds: [
      buildInfoEmbed(
        client,
        client.config.embedColor,
        t(
          action === "remove"
            ? "lavalink.selectNodeRemove"
            : "lavalink.selectNodeReplace"
        )
      ),
    ],
    components: buildNodePickerComponents(nodes, action),
  });

  const pickerMessage = await button.fetchReply().catch(() => null);
  if (!pickerMessage) return;
  const collector = pickerMessage.createMessageComponentCollector({
    time: SUBMENU_TIMEOUT,
    filter: (picker) =>
      picker.user.id === button.user.id &&
      picker.customId.startsWith(`lava:pick:${action}:`),
  });

  collector.on("collect", async (picker) => {
    const nodeId = picker.customId.split(":")[3];
    const node = getConfiguredNodes(client).find(
      (currentNode) => currentNode.id === nodeId
    );
    if (!node) {
      await picker
        .reply({
          embeds: [
            buildInfoEmbed(
              client,
              "#FF0000",
              t("lavalink.nodeNotFound", { id: nodeId, available: "" })
            ),
          ],
          ephemeral: true,
        })
        .catch(() => {});
      return;
    }

    collector.stop("selected");
    if (action === "remove") {
      await openRemoveConfirmation(client, picker, node, mainInteraction);
    } else {
      await showNodeInputModal(
        client,
        picker,
        "replace",
        mainInteraction,
        node.id
      );
    }
  });

  collector.on("end", (_collected, reason) => {
    if (reason === "time" || reason === "selected")
      button.deleteReply().catch(() => {});
  });
}

async function showNodeInputModal(
  client,
  button,
  action,
  mainInteraction,
  nodeId = null
) {
  const modal = new ModalBuilder()
    .setCustomId(`lava:modal:${action}:${nodeId || "new"}`)
    .setTitle(
      t(
        action === "replace"
          ? "lavalink.replaceFormTitle"
          : action === "test"
          ? "lavalink.testFormTitle"
          : "lavalink.addFormTitle"
      )
    );
  const input = new TextInputBuilder()
    .setCustomId("node-input")
    .setLabel(t("lavalink.nodeFormatLabel"))
    .setPlaceholder(t("lavalink.nodeFormatPlaceholder"))
    .setStyle(TextInputStyle.Short)
    .setMaxLength(300)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await button.showModal(modal);

  let submission;
  try {
    submission = await button.awaitModalSubmit({
      time: MODAL_TIMEOUT,
      filter: (submitted) =>
        submitted.user.id === button.user.id &&
        submitted.customId === modal.data.custom_id,
    });
  } catch {
    return;
  }

  let nodeInput;
  try {
    nodeInput = parseNodeInput(
      submission.fields.getTextInputValue("node-input")
    );
  } catch (error) {
    await submission
      .reply({
        embeds: [buildInfoEmbed(client, "#FF0000", error.message)],
        ephemeral: true,
      })
      .catch(() => {});
    return;
  }

  await submission.deferReply({ ephemeral: true }).catch(() => {});
  const reportProgress = (embed) =>
    submission.editReply({ embeds: [embed], components: [] }).catch(() => {});
  let result;
  if (action === "add") {
    result = await addNode(client, nodeInput, reportProgress);
  } else if (action === "test") {
    const testResult = await testNode(client, nodeInput, reportProgress);
    await submission
      .editReply({
        embeds: [testResult.embed],
        components: [],
      })
      .catch(() => {});
    if (testResult.success) {
      await offerTestedNodeAdd(client, submission, nodeInput, mainInteraction);
    }
    return;
  } else {
    result = await replaceNode(client, nodeId, nodeInput, reportProgress);
  }
  await submission
    .editReply({ embeds: [result], components: [] })
    .catch(() => {});
  if (action !== "test")
    await refreshMainMenu(client, mainInteraction).catch(() => {});
}

async function toggleNode(client, nodeId) {
  const nodes = getConfiguredNodes(client);
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index === -1)
    throw new Error(t("lavalink.nodeNotFound", { id: nodeId, available: "" }));

  nodes[index].enabled = !isNodeEnabled(nodes[index]);
  await client.saveLavalinkNodes(nodes);
  client.manager.options.nodes = nodes;
}

const command = new SlashCommand()
  .setName("lavalink")
  .setDescription(t("lavalink.auto_79"))
  .setAdminOnly(true)
  .setRun((client, interaction) =>
    client.withGuildLanguage(interaction.guildId, async () => {
      if (interaction.user.id !== client.config.adminId) {
        return interaction.reply({
          embeds: [client.ErrorEmbed(t("lavalink.noPermission"))],
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });
      const mainMessage = await interaction.editReply({
        embeds: [buildMainEmbed(client)],
        components: buildMainComponents(client),
        fetchReply: true,
      });
      const collector = mainMessage.createMessageComponentCollector({
        filter: (button) => button.user.id === interaction.user.id,
      });

      collector.on("collect", (button) =>
        client.withGuildLanguage(interaction.guildId, async () => {
          const [, type, value] = button.customId.split(":");
          if (type === "toggle") {
            await button.deferUpdate().catch(() => {});
            try {
              await toggleNode(client, value);
              await refreshMainMenu(client, interaction);
            } catch (error) {
              await button
                .followUp({
                  embeds: [
                    buildInfoEmbed(
                      client,
                      "#FF0000",
                      t("lavalink.errorGeneric", { error: error.message })
                    ),
                  ],
                  ephemeral: true,
                })
                .catch(() => {});
            }
            return;
          }

          if (type !== "action") return;
          if (value === "add" || value === "test") {
            await showNodeInputModal(client, button, value, interaction);
            return;
          }
          if (value === "remove" || value === "replace") {
            await openNodePicker(client, button, value, interaction);
            return;
          }
          if (value === "reload") {
            await button.deferReply({ ephemeral: true }).catch(() => {});
            const result = await reloadNodes(client, (embed) =>
              button
                .editReply({ embeds: [embed], components: [] })
                .catch(() => {})
            );
            await button
              .editReply({ embeds: [result], components: [] })
              .catch(() => {});
            await refreshMainMenu(client, interaction).catch(() => {});
          }
        })
      );
    })
  );

module.exports = command;
