import { hashData } from "./utils";
import { addRecord, createLedger, mine } from "./core";

import {
  generateKey,
  readPrivateKey,
  readKey,
  decryptKey,
  createMessage,
  sign,
  readCleartextMessage,
  verify,
} from "openpgp";

function generateId() {
  const uint32 = window.crypto.getRandomValues(new Uint32Array(1))[0];
  return uint32.toString(16);
}

const availableHooks = [
  "onAuth",
  "onLoad",
  "onReady",
  "onCreate",
  "onUpdate",
  "onUnload",
  "onBeforeReplay",
  "onReplay",
  "onCommit",
  "onAdd",
  "onDestroy",
];

export default (
  config = {
    plugins: [],
    identity: null,
    secret: null,
    ledger: null,
  }
) => {
  const state = {
    ledger: null,
    signingKey: null,
  };

  let hooks = availableHooks.reduce(
    (acc, curr) => ({
      ...acc,
      [curr]: [],
    }),
    {}
  );

  config.plugins.forEach((plugin) => {
    availableHooks.forEach((hook) => {
      if (plugin[hook]) {
        hooks[hook] = [...hooks[hook], plugin[hook]];
      }
    });
  });

  async function runHooks(type, props = {}) {
    let i = 0;
    let len = hooks[type].length;
    for (; i < len; i++) {
      await hooks[type][i](JSON.parse(JSON.stringify(props)));
    }
  }

  async function auth(privateKey, publicKey) {
    state.signingKey = privateKey;
    state.publicKey = publicKey;
    await runHooks("onAuth");
  }

  async function create(genesisRecord = {}, difficulty = 1) {
    const timestamp = Date.now();
    const id = await hashData(`${timestamp}`);

    const record = {
      ...genesisRecord,
      id,
      timestamp,
      openPGP: state.publicKey,
    };

    const privateKey = await decryptKey({
      privateKey: await readPrivateKey({ armoredKey: state.signingKey }),
      passphrase: "password1",
    });

    const signature = await sign({
      message: await createMessage({ text: JSON.stringify(record) }),
      signingKeys: privateKey,
      detached: true,
    });

    const signedRecord = {
      signature,
      ...record,
    };
    state.ledger = await createLedger(signedRecord, difficulty);
    await runHooks("onAdd", signedRecord);
    await runHooks("onCreate", state);
    await runHooks("onLoad", state);
    await runHooks("onReady", state);
  }

  async function load(ledger, shouldReplay = true) {
    state.ledger = ledger;
    await runHooks("onLoad", state);
    if (shouldReplay) {
      await replay();
    }
    await runHooks("onReady", state);
  }

  const add = async (data, collection, { silent = false } = {}) => {
    if (!state.signingKey) {
      console.warn("Cannot add record: signingKey not verified");
      return;
    }

    if (!state.ledger) {
      console.warn("Cannot add record: ledger not loaded");
      return;
    }

    const timestamp = Date.now();

    const record = {
      data,
      timestamp,
      openPGP: state.publicKey,
    };

    if (collection) {
      record.collection = collection;
    }

    record.id = await hashData(`${JSON.stringify(record)}`);
    const privateKey = await decryptKey({
      privateKey: await readPrivateKey({ armoredKey: state.signingKey }),
      passphrase: "password1",
    });

    const signature = await sign({
      message: await createMessage({ text: JSON.stringify(record) }),
      signingKeys: privateKey,
      detached: true,
    });

    const signedRecord = {
      signature,
      ...record,
    };

    state.ledger = await addRecord(signedRecord, { ...state.ledger });

    if (!silent) {
      await runHooks("onAdd", signedRecord);
      await runHooks("onUpdate", state);
    }

    return signedRecord;
  };

  async function replay(from, to) {
    if (!state.ledger) {
      console.warn("Cannot replay: ledger not loaded");
      return;
    }

    const { chain, pending_records } = state.ledger;
    const records = [
      ...chain.reduce((acc, block) => [...acc, ...block.records], []),
      ...pending_records.map((r) => ({ ...r })),
    ].sort((a, b) => a.timestamp - b.timestamp);

    let i = from ? records.findIndex(({ id }) => id === from) : 0;

    const len = to
      ? records.findIndex(({ id }) => id === to) + 1
      : records.length;

    if (i < 0) {
      console.warn(`Cannot replay: transaction ${from} not found`);
      return;
    }

    await runHooks("onBeforeReplay", { from, to });

    for (; i < len; i++) {
      await runHooks("onAdd", records[i]);
    }
    await runHooks("onReplay", { from, to, ...state });
  }

  async function destroy() {
    await runHooks("onDestroy", state);
  }

  async function commit(message) {
    state.ledger = await mine(state.ledger, { message });
    await runHooks("onCommit", state);
    await runHooks("onUpdate", state);
    return state.ledger;
  }

  if (config.secret && config.identity) {
    auth(config);
    if (config.ledger) {
      load(config.ledger);
    }
  }

  async function squashRecords() {
    const lookup = {};
    for (let i = 0; i < state.ledger.pending_records.length; i++) {
      const record = state.ledger.pending_records[i];

      lookup[`${record.data.id}_${record.collection}`] = {
        data: {
          ...(lookup[`${record.data.id}_${record.collection}`]?.data || {}),
          ...record.data,
        },
        collection: record.collection,
      };
    }

    state.ledger.pending_records = [];

    const squashedRecords = Object.values(lookup).map((record) => {
      return new Promise(async (resolve, reject) => {
        try {
          resolve(
            await add(
              {
                id: generateId(),
                ...record.data,
              },
              record.collection,
              { silent: true }
            )
          );
        } catch (e) {
          reject(e);
        }
      });
    });

    const pending_records = await Promise.all(squashedRecords);
    state.ledger.pending_records = pending_records;
    await runHooks("onUpdate", state);
  }

  return {
    auth,
    load,
    create,
    replay,
    commit,
    add,
    destroy,
    squashRecords,
  };
};