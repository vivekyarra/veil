import { describe, expect, it, vi } from "vitest";
import {
  dispatch,
  number,
  optionalPin,
  reply,
  text,
} from "../electron/ipc/dispatch";
import { vaultCommands } from "../electron/ipc/vault-commands";
import { incidentCommands } from "../electron/ipc/incident-commands";
import {
  COVER_SCENE,
  obsCommands,
  profileLevel,
} from "../electron/ipc/obs-commands";
import { IncidentEngine } from "../electron/incidents/engine";
import { Vault, type SafeStorage } from "../electron/vault/vault";
import { Store } from "../electron/store/store";
import { ObsClient } from "../electron/obs/client";
import { Supervisor } from "../electron/supervisor";
import { defaultSettings } from "../electron/store/settings";
import type { Helix } from "../electron/twitch/helix";
import { obsMock } from "./mocks";

const fakeOS: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
};

describe("dispatch", () => {
  it("returns a snapshot, a reply value, or an error message", async () => {
    const changed = vi.fn();
    const commands = {
      plain: () => {},
      value: () => reply(42),
      broken: () => {
        throw new Error("nope");
      },
      odd: () => {
        throw "string";
      },
    };
    const run = (op: unknown, input?: unknown) =>
      dispatch(commands, op, input, () => "snap", changed);
    expect(await run("plain", null)).toEqual({ ok: true, value: "snap" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await run("value")).toEqual({ ok: true, value: 42 });
    expect(await run("broken")).toEqual({ ok: false, error: "nope" });
    expect(await run("odd")).toEqual({ ok: false, error: "Operation failed" });
    expect(await run("toString")).toMatchObject({ error: "Unknown operation" });
    expect(await run(5)).toMatchObject({ error: "Invalid input" });
  });

  it("drops prototype keys, arrays and foreign objects from payloads", async () => {
    const seen: unknown[] = [];
    const commands = {
      echo: (data: Record<string, unknown>) => {
        seen.push(data);
        return reply(Object.getPrototypeOf(data));
      },
    };
    const run = (input: unknown) =>
      dispatch(
        commands,
        "echo",
        input,
        () => "snap",
        () => {},
      );
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"prototype":1,"id":"a"}',
    ) as unknown;
    expect(await run(hostile)).toEqual({ ok: true, value: null });
    const data = seen.at(-1) as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["id"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    for (const input of [["x"], new Date(), "str", 7, null, undefined]) {
      await run(input);
      expect(Object.keys(seen.at(-1) as object)).toEqual([]);
    }
    expect(
      await run(
        Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, i])),
      ),
    ).toMatchObject({ ok: false });
    for (const op of [
      "__proto__",
      "constructor",
      "hasOwnProperty",
      "x".repeat(41),
    ])
      expect(
        await dispatch(
          commands,
          op,
          {},
          () => 0,
          () => {},
        ),
      ).toMatchObject({
        ok: false,
      });
  });

  it("validates inputs", () => {
    expect(() => text("x".repeat(6), 5)).toThrow();
    expect(() => number(Infinity, 0, 1)).toThrow();
    expect(number(1, 0, 1)).toBe(1);
    expect(optionalPin("")).toBeUndefined();
    expect(optionalPin("123456")).toBe("123456");
    expect(profileLevel("off")).toBe(0);
    expect(profileLevel("balanced")).toBe(1);
    expect(profileLevel("paranoid")).toBe(2);
  });
});

describe("vault commands", () => {
  function setup(helix?: Partial<Helix>) {
    const store = new Store(":memory:"),
      vault = new Vault(store, fakeOS),
      sync = vi.fn(async () => {}),
      notify = vi.fn();
    const commands = vaultCommands({
      vault,
      helix: () => helix as Helix | undefined,
      sync,
      notify,
    });
    const run = (op: string, input: unknown = {}) =>
      dispatch(
        commands,
        op,
        input,
        () => "snap",
        () => {},
      );
    return { store, vault, sync, notify, run };
  }
  it("adds, imports, edits, reveals, deletes and wipes with the PIN", async () => {
    const { vault, run, sync, store } = setup();
    expect(
      (await run("vault-add", { text: "Synthetic", category: "custom" })).ok,
    ).toBe(true);
    expect(
      (await run("vault-import", { text: "One\nTwo\n", category: "custom" }))
        .ok,
    ).toBe(true);
    expect(vault.list()).toHaveLength(3);
    expect(
      await run("vault-import", {
        text: "x\n".repeat(1000),
        category: "custom",
      }),
    ).toMatchObject({ ok: false });
    expect((await run("vault-pin", { pin: "123456" })).ok).toBe(true);
    const [first] = vault.list();
    expect(await run("vault-reveal", { id: first.id })).toMatchObject({
      ok: false,
    });
    expect((await run("vault-unlock", { pin: "123456" })).ok).toBe(true);
    expect(await run("vault-reveal", { id: first.id })).toEqual({
      ok: true,
      value: "Synthetic",
    });
    expect(
      (
        await run("vault-edit", {
          id: first.id,
          text: "Edited",
          category: "name",
        })
      ).ok,
    ).toBe(true);
    // A fresh vault instance on the same store has no active unlock.
    const fresh = vaultCommands({
      vault: new Vault(store, fakeOS),
      helix: () => undefined,
      sync,
      notify: () => {},
    });
    const freshRun = (op: string, input: unknown) =>
      dispatch(
        fresh,
        op,
        input,
        () => "snap",
        () => {},
      );
    expect(await freshRun("vault-delete", { id: first.id })).toMatchObject({
      ok: false,
      error: "Enter your vault PIN to delete a term",
    });
    expect(
      (await freshRun("vault-delete", { id: first.id, pin: "123456" })).ok,
    ).toBe(true);
    expect(
      await freshRun("vault-wipe", { confirm: true, pin: "000000" }),
    ).toMatchObject({
      ok: false,
    });
    expect(await freshRun("vault-wipe", { pin: "123456" })).toMatchObject({
      error: "Confirm vault wipe",
    });
    expect(
      (await freshRun("vault-wipe", { confirm: true, pin: "123456" })).ok,
    ).toBe(true);
    expect(vault.list()).toHaveLength(0);
    expect(sync).toHaveBeenCalled();
    store.close();
  });

  it("rejects malformed payloads for every command without side effects", async () => {
    const { vault, run, sync } = setup();
    const huge = "x".repeat(1_000_000);
    const bad: unknown[] = [
      {},
      { text: huge, category: "custom", id: huge, pin: huge },
      { text: 5, category: [], id: {}, pin: 123456 },
      { text: null, category: { toString: () => "custom" }, id: true },
    ];
    for (const op of [
      "vault-add",
      "vault-edit",
      "vault-import",
      "vault-pin",
      "vault-unlock",
      "vault-reveal",
      "vault-delete",
    ])
      for (const input of bad)
        expect((await run(op, input)).ok, `${op}`).toBe(false);
    expect(vault.list()).toHaveLength(0);
    expect(vault.hasPin()).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  it("refuses delete and wipe without the PIN once unlock expires", async () => {
    vi.useFakeTimers();
    try {
      const { vault, run } = setup();
      await run("vault-add", { text: "Synthetic", category: "custom" });
      await run("vault-pin", { pin: "123456" });
      vi.advanceTimersByTime(60000);
      const [entry] = vault.list();
      for (const pin of [undefined, "", "000000", 123456])
        expect((await run("vault-delete", { id: entry.id, pin })).ok).toBe(
          false,
        );
      for (const pin of [undefined, "", "000000"])
        expect((await run("vault-wipe", { confirm: true, pin })).ok).toBe(
          false,
        );
      expect(
        (await run("vault-wipe", { confirm: "true", pin: "123456" })).ok,
      ).toBe(false);
      expect(vault.list()).toHaveLength(1);
      expect(
        (await run("vault-delete", { id: entry.id, pin: "123456" })).ok,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opts terms in and out of Twitch blocked terms with confirmation", async () => {
    const helix = {
      blockedTerm: vi.fn(async () => ({ data: [{ id: "bt1", text: "" }] })),
      removeBlockedTerm: vi.fn(async () => {}),
    };
    const { vault, run, notify, store } = setup(helix);
    const id = vault.add("Synthetic", "custom");
    expect(await run("vault-optin", { id })).toMatchObject({ ok: false });
    expect(
      await run("vault-optin", { id: "missing", confirm: true }),
    ).toMatchObject({
      error: "Entry missing",
    });
    expect((await run("vault-optin", { id, confirm: true })).ok).toBe(true);
    expect(vault.list()[0].optedIn).toBe(true);
    expect(await run("vault-wipe", { confirm: true })).toMatchObject({
      ok: false,
    });
    expect((await run("vault-optin", { id, confirm: true })).ok).toBe(true);
    expect(helix.removeBlockedTerm).toHaveBeenCalledWith("bt1");
    expect((await run("vault-optin", { id, confirm: true })).ok).toBe(true);
    expect((await run("vault-delete", { id })).ok).toBe(true);
    expect(helix.removeBlockedTerm).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalled();
    const offline = setup();
    expect(await offline.run("vault-optin", { id })).toMatchObject({
      error: "Connect Twitch first",
    });
    const optedId = offline.vault.add("x y", "custom");
    offline.vault.markOptIn(optedId, "bt2");
    expect(await offline.run("vault-delete", { id: optedId })).toMatchObject({
      error: "Reconnect Twitch before removing an opted-in term",
    });
    store.close();
    offline.store.close();
  });
});

describe("incident commands", () => {
  it("routes panic, incidents, approvals and rehearsal", async () => {
    const engine = new IncidentEngine(
      {
        cover: async () => {},
        mute: async () => {},
        unmute: async () => {},
        guard: async () => {},
        retroactive: async () => {},
        marker: async () => undefined,
        shield: async () => {},
        blocked: async () => {},
        notice: async () => {},
        discord: async () => {},
        clips: async () => [],
      },
      async () => false,
      () => {},
      () => {},
    );
    const ctx = {
      engine: () => engine,
      panic: vi.fn((trigger: "panic" | "manual", terms: string[]) =>
        engine.open(trigger, terms).then(() => {}),
      ),
      answer: vi.fn(),
      setRehearsal: vi.fn(),
      completeOnboarding: vi.fn(),
      simulateChat: vi.fn(async () => {}),
    };
    const commands = incidentCommands(ctx);
    const run = (op: string, input: unknown = {}) =>
      dispatch(
        commands,
        op,
        input,
        () => "snap",
        () => {},
      );
    try {
      await run("panic");
      expect(ctx.panic).toHaveBeenCalledWith("panic", []);
      await run("incident-open", { text: "Synthetic" });
      expect(ctx.panic).toHaveBeenLastCalledWith("manual", ["Synthetic"]);
      await run("incident-open", {});
      expect(ctx.panic).toHaveBeenLastCalledWith("manual", []);
      await run("incident-clips", { id: 1 });
      await run("incident-clips", { id: 99 });
      expect((await run("incident-close", { id: 1 })).ok).toBe(true);
      expect(engine.incidents[0].state).toBe("closed");
      expect(await run("incident-close", { id: 0 })).toMatchObject({
        ok: false,
      });
      await run("ask", { id: "a", yes: true });
      expect(ctx.answer).toHaveBeenCalledWith("a", true);
      await run("rehearsal", { enabled: false });
      expect(ctx.setRehearsal).toHaveBeenCalledWith(false);
      await run("onboarding-complete");
      expect(ctx.completeOnboarding).toHaveBeenCalled();
      await run("simulate-chat");
      expect(ctx.simulateChat).toHaveBeenCalled();
    } finally {
      engine.dispose();
    }
  });
});

describe("obs commands", () => {
  it("connects, creates the cover from a real file, lists scenes and installs", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:"),
      obs = new ObsClient(store),
      settings = defaultSettings(),
      persist = vi.fn();
    const commands = obsCommands({
      obs,
      detector: new Supervisor("a".repeat(64), "http://127.0.0.1:9"),
      settings: () => settings,
      persist,
      coverFile: () => "/real/path/cover.html",
      credentialPath: () => "token.json",
      detectorReady: () => false,
      vaultCategories: () => 0,
      twitchReady: () => false,
      eventsubConnected: () => false,
    });
    const run = (op: string, input: unknown = {}) =>
      dispatch(
        commands,
        op,
        input,
        () => "snap",
        () => {},
      );
    try {
      expect(
        (await run("obs-connect", { url: mock.url, password: "" })).ok,
      ).toBe(true);
      expect(settings.obsUrl).toBe(mock.url);
      expect(persist).toHaveBeenCalled();
      expect(mock.browserInputs["VEIL Cover Card"].local_file).toBe(
        "/real/path/cover.html",
      );
      const scenes = await run("obs-scenes");
      expect(scenes.value).toEqual(["Live"]);
      expect(scenes.value).not.toContain(COVER_SCENE);
      expect(await run("obs-install", {})).toMatchObject({
        error: "Select scenes",
      });
      expect((await run("obs-install", { scenes: ["Live"] })).ok).toBe(true);
      expect(mock.filters.Live).toHaveLength(1);
      const checks = await run("preflight");
      expect(Array.isArray(checks.value)).toBe(true);
      await obs.disconnect();
    } finally {
      await mock.close();
      store.close();
    }
  });
});
