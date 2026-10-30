import { it, expect, vi } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { twitchMock, obsMock, eventSubMock } from "./mocks";
import { Store } from "../electron/store/store";
import { ObsClient } from "../electron/obs/client";
import { TwitchAuth, SCOPES, type Tokens } from "../electron/twitch/auth";
import { Helix } from "../electron/twitch/helix";
import { EventSub, ChatRing } from "../electron/twitch/eventsub";
import {
  Vault,
  tokenPersistence,
  type SafeStorage,
} from "../electron/vault/vault";
import { ChatGuard, type GuardEvent } from "../electron/guard/chat-guard";
import { IncidentEngine } from "../electron/incidents/engine";
import { RehearsalActions } from "../electron/rehearsal/rehearsal";
import { report } from "../electron/incidents/report";
const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const fakeOS: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s.split("").reverse().join("")),
  decryptString: (b) => b.toString().split("").reverse().join(""),
};

it("OBS onboarding and audio rollback survive a simulated process crash", async () => {
  const mock = await obsMock(),
    store = new Store(":memory:"),
    first = new ObsClient(store);
  try {
    await first.connect(mock.url, "synthetic");
    await first.install(["Live"], "synthetic-token.json", 750, 1);
    expect(mock.offsets).toEqual({ Mic: 775, Desktop: 740 });
    expect(mock.filters.Live).toHaveLength(1);
    await first.socket.disconnect();
    const restarted = new ObsClient(store);
    await restarted.connect(mock.url, "synthetic");
    expect(mock.offsets).toEqual({ Mic: 25, Desktop: -10 });
    await restarted.delayAudio(1000);
    await restarted.disconnect();
    expect(mock.offsets).toEqual({ Mic: 25, Desktop: -10 });
  } finally {
    await mock.close();
    store.close();
  }
});
it("cover fits the OBS canvas and updates an existing browser source", async () => {
  const mock = await obsMock(),
    store = new Store(":memory:"),
    obs = new ObsClient(store);
  try {
    await obs.connect(mock.url, "synthetic");
    await obs.createCover("first-cover.html");
    expect(mock.browserInputs["VEIL Cover Card"]).toMatchObject({
      width: 1280,
      height: 720,
      local_file: "first-cover.html",
    });
    await obs.createCover("updated-cover.html");
    expect(mock.requests.filter((r) => r === "CreateInput")).toHaveLength(1);
    expect(mock.browserInputs["VEIL Cover Card"]).toMatchObject({
      width: 1280,
      height: 720,
      local_file: "updated-cover.html",
    });
    await obs.disconnect();
  } finally {
    await mock.close();
    store.close();
  }
});
it("device authorization polls and serializes single-use refresh tokens", async () => {
  const mock = await twitchMock();
  let tokens: Tokens | undefined;
  const auth = new TwitchAuth(
    "synthetic-client",
    {
      load: () => tokens,
      save: (t) => {
        tokens = t;
      },
      clear: () => {
        tokens = undefined;
      },
    },
    mock.url,
  );
  try {
    const device = await auth.begin();
    tokens = await auth.poll(device);
    expect(tokens.refresh_token).toBe("rotated-synthetic-refresh");
    await Promise.all([auth.refresh(), auth.refresh(), auth.refresh()]);
    expect(
      mock.requests.filter(
        (r) =>
          (r.body as Record<string, string>)?.grant_type === "refresh_token",
      ),
    ).toHaveLength(1);
    expect(
      (mock.requests[0].body as Record<string, string>).scopes.split(" "),
    ).toEqual([...SCOPES]);
  } finally {
    await mock.close();
  }
});
it("real loopback EventSub -> private matcher -> Helix deletion meets mock latency budget", async () => {
  const mock = await twitchMock(),
    events = await eventSubMock(),
    durations: number[] = [],
    emitted: GuardEvent[] = [];
  const helix = new Helix(
    { clientId: "synthetic-client", access: async () => "synthetic-token" },
    "synthetic-user",
    mock.url + "/helix",
  );
  const guard = new ChatGuard(
    helix,
    (e) => {
      emitted.push(e);
      if (e.kind === "deleted") durations.push(e.duration_ms);
    },
    () => {},
  );
  guard.setTerms([{ text: "123 Main St", category: "address" }]);
  const sub = new EventSub(
    helix,
    (m) => {
      void guard.receive(m);
    },
    () => {},
    events.url,
  );
  try {
    sub.start();
    // Server receipt precedes the final subscription response reaching the
    // client. Wait for acknowledged readiness before sending chat traffic.
    for (let i = 0; i < 100 && !sub.connected; i++) await wait();
    expect(sub.connected).toBe(true);
    for (let i = 0; i < 30; i++) {
      const frame = {
        metadata: {
          message_id: `event-${i}`,
          message_type: "notification",
          message_timestamp: new Date().toISOString(),
          subscription_type: "channel.chat.message",
        },
        payload: {
          event: {
            message_id: `chat-${i}`,
            chatter_user_id: `viewer-${i}`,
            chatter_user_login: `synthetic_${i}`,
            badges: [],
            message: { text: "1 2 3 m4in st" },
          },
        },
      };
      events.send(frame);
      events.send(frame);
    }
    for (let i = 0; i < 200 && durations.length < 30; i++) await wait();
    expect(durations).toHaveLength(30);
    const sorted = durations.sort((a, b) => a - b),
      p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    expect(p95).toBeLessThan(1000);
    expect(mock.requests.filter((r) => r.method === "DELETE")).toHaveLength(30);
    expect(JSON.stringify(emitted)).not.toContain("m4in");
    const dir = join(import.meta.dirname, "../../docs");
    writeFileSync(
      join(dir, "chat-benchmark.json"),
      JSON.stringify(
        {
          mode: "loopback contract mock; not live Twitch",
          samples: durations.length,
          p95_ms: p95,
          max_ms: sorted.at(-1),
        },
        null,
        2,
      ),
    );
  } finally {
    sub.stop();
    await events.close();
    await mock.close();
  }
});
it("AES vault ciphertext and default reports contain no planted private text", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "veil-test-")), "vault.sqlite"),
    store = new Store(path),
    vault = new Vault(store, fakeOS);
  const planted = "Synthetic Maple Academy";
  const id = vault.add(planted, "school");
  expect(JSON.stringify(vault.list())).not.toContain(planted);
  expect(() => vault.reveal(id)).toThrow();
  vault.setPin("123456");
  expect(() => vault.unlock("000000")).toThrow();
  vault.unlock("123456");
  expect(vault.reveal(id)).toBe(planted);
  const persisted = tokenPersistence(store, fakeOS);
  persisted.save({
    access_token: "synthetic",
    refresh_token: "synthetic-refresh",
    expires_in: 3600,
    obtained_at: 0,
  });
  expect(persisted.load()?.access_token).toBe("synthetic");
  persisted.clear();
  expect(persisted.load()).toBeUndefined();
  vault.remove(id);
  expect(vault.list()).toHaveLength(0);
  vault.add(planted, "school");
  vault.dispose();
  store.close();
  expect(readFileSync(path).toString()).not.toContain(planted);
});
it("panic covers immediately, executes Auto actions and defaults Ask to No without secret persistence", async () => {
  const adapter = new RehearsalActions(),
    events: GuardEvent[] = [];
  let saved = "";
  const guard = new ChatGuard(
    adapter,
    (e) => events.push(e),
    () => {},
  );
  const engine = new IncidentEngine(
    adapter.incidentActions(guard),
    async () => false,
    (value) => {
      saved = JSON.stringify(value);
    },
    () => {},
    true,
  );
  try {
    const start = performance.now(),
      incident = await engine.open("panic", ["Synthetic Maple Academy"]);
    expect(performance.now() - start).toBeLessThan(300);
    expect(adapter.covered).toBe(true);
    expect(incident.state).toBe("contained");
    expect(incident.actions.find((a) => a.action === "shield")?.status).toBe(
      "declined",
    );
    expect(
      incident.actions
        .filter((a) =>
          ["cover", "guard", "retroactive", "marker"].includes(a.action),
        )
        .every((a) => a.status === "success"),
    ).toBe(true);
    for (let i = 0; i < 3; i++)
      await guard.receive({
        id: String(i),
        userId: "same-user",
        login: "synthetic_viewer",
        text: "Synthetic Maple Academy",
        timestamp: Date.now(),
        privileged: false,
      });
    expect(adapter.timeouts).toHaveLength(1);
    expect(events.some((e) => e.kind === "review")).toBe(true);
    expect(saved + report(incident) + JSON.stringify(events)).not.toContain(
      "Synthetic Maple Academy",
    );
    expect(report(incident, ["Synthetic Maple Academy"])).toContain(
      "Synthetic Maple Academy",
    );
    engine.close(incident.id);
    await engine.collectClips(incident);
    expect(incident.clips).toHaveLength(1);
  } finally {
    engine.dispose();
  }
});
it("chat retention is bounded by age and count; privileged users are warned", async () => {
  const ring = new ChatRing();
  for (let i = 0; i < 50001; i++)
    ring.add({
      id: String(i),
      userId: "synthetic",
      login: "synthetic",
      text: "hello",
      timestamp: Date.now(),
      privileged: false,
    });
  expect(ring.messages).toHaveLength(50000);
  ring.prune(Date.now() + 6 * 3600000 + 1);
  expect(ring.messages).toHaveLength(0);
  const actions = {
      deleteMessage: vi.fn(async () => {}),
      timeout: vi.fn(async () => {}),
    },
    emit = vi.fn();
  const guard = new ChatGuard(actions, emit, () => {});
  guard.setTerms([{ text: "secretphrase", category: "custom" }]);
  await guard.receive({
    id: "mod",
    userId: "mod",
    login: "synthetic_mod",
    text: "secretphrase",
    timestamp: Date.now(),
    privileged: true,
  });
  expect(actions.deleteMessage).not.toHaveBeenCalled();
  expect(emit.mock.calls[0][0].kind).toBe("warning");
});
