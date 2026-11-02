import { describe, expect, it, vi } from "vitest";
import { ObsClient } from "../electron/obs/client";
import { Store } from "../electron/store/store";
import {
  Vault,
  tokenPersistence,
  type SafeStorage,
} from "../electron/vault/vault";
import {
  defaultSettings,
  loadSettings,
  patchSettings,
  startupRehearsal,
} from "../electron/store/settings";
import {
  PRACTICE_TERMS,
  practiceChat,
  RehearsalActions,
} from "../electron/rehearsal/rehearsal";
import { ChatGuard } from "../electron/guard/chat-guard";
import { obsMock } from "./mocks";

const fakeOS = (backend?: string): SafeStorage => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s.split("").reverse().join("")),
  decryptString: (b) => b.toString().split("").reverse().join(""),
  ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
});

describe("OBS panic robustness", () => {
  it("mutes audible inputs on panic and restores only those", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:"),
      obs = new ObsClient(store);
    try {
      await obs.connect(mock.url, "");
      await obs.muteInputs();
      expect(mock.mutes).toEqual({ Mic: true, Desktop: true });
      expect(store.get("muteRollback", [])).toEqual(["Mic"]);
      // A restarted client restores from the durable rollback list.
      const restarted = new ObsClient(store);
      await restarted.connect(mock.url, "");
      await restarted.unmuteInputs();
      expect(mock.mutes).toEqual({ Mic: false, Desktop: true });
      expect(store.get("muteRollback", ["x"])).toEqual([]);
      store.set("muteRollback", ["Removed input"]);
      await restarted.unmuteInputs();
      expect(store.get("muteRollback", ["x"])).toEqual([]);
      await restarted.disconnect();
      await obs.disconnect();
    } finally {
      await mock.close();
      store.close();
    }
  });

  it("reconnects with backoff after the connection drops, keeping audio offsets", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:"),
      obs = new ObsClient(store, 50);
    const status: string[] = [];
    obs.onStatus = (s) => status.push(s);
    try {
      await obs.connect(mock.url, "");
      await obs.install(["Live"], "token.json", 750, 1);
      mock.drop();
      await expect
        .poll(() => status)
        .toContain("OBS connection lost; reconnecting");
      await expect.poll(() => obs.connected, { timeout: 5000 }).toBe(true);
      expect(status).toContain("OBS reconnected");
      expect(mock.offsets).toEqual({ Mic: 775, Desktop: 740 });
      await obs.cover();
      expect(mock.program).toBe("VEIL Cover");
      await obs.disconnect();
      expect(mock.offsets).toEqual({ Mic: 25, Desktop: -10 });
    } finally {
      await mock.close();
      store.close();
    }
  });

  it("an intentional disconnect never reconnects", async () => {
    const mock = await obsMock(),
      store = new Store(":memory:"),
      obs = new ObsClient(store, 20);
    try {
      await obs.connect(mock.url, "");
      await obs.connect(mock.url, "");
      await obs.disconnect();
      await new Promise((r) => setTimeout(r, 100));
      expect(obs.connected).toBe(false);
    } finally {
      await mock.close();
      store.close();
    }
  });
});

describe("Vault hardening", () => {
  it("requires the PIN for delete and wipe", () => {
    const store = new Store(":memory:"),
      vault = new Vault(store, fakeOS());
    const id = vault.add("Synthetic Lane", "address");
    vault.remove(id);
    const kept = vault.add("Synthetic Lane", "address");
    vault.setPin("123456");
    const locked = new Vault(store, fakeOS());
    expect(() => locked.remove(kept)).toThrow("Enter your vault PIN");
    expect(() => locked.remove(kept, "000000")).toThrow("Incorrect");
    expect(() => locked.wipe()).toThrow("Enter your vault PIN");
    locked.remove(kept, "123456");
    expect(locked.list()).toHaveLength(0);
    locked.add("Synthetic Lane", "address");
    locked.wipe("123456");
    expect(locked.list()).toHaveLength(0);
    store.close();
  });

  it("persists the failed-attempt lockout across restarts", () => {
    const store = new Store(":memory:");
    const vault = new Vault(store, fakeOS());
    vault.setPin("123456");
    for (let i = 0; i < 4; i++)
      expect(() => new Vault(store, fakeOS()).unlock("000000")).toThrow(
        "Incorrect",
      );
    expect(() => new Vault(store, fakeOS()).unlock("000000")).toThrow();
    expect(() => new Vault(store, fakeOS()).unlock("123456")).toThrow(
      "Too many PIN attempts",
    );
    store.close();
  });

  it("refuses Linux basic_text secure storage", () => {
    const store = new Store(":memory:");
    expect(() => new Vault(store, fakeOS("basic_text"), "linux")).toThrow(
      "keyring",
    );
    expect(() => new Vault(store, fakeOS("basic_text"), "win32")).not.toThrow();
    expect(
      () => new Vault(store, fakeOS("gnome_libsecret"), "linux"),
    ).not.toThrow();
    expect(() =>
      tokenPersistence(store, fakeOS("basic_text"), "linux").save({
        access_token: "a",
        refresh_token: "b",
        expires_in: 1,
        obtained_at: 0,
      }),
    ).toThrow("keyring");
    store.close();
  });
});

describe("Settings", () => {
  it("validates the protected channel", () => {
    expect(
      patchSettings(defaultSettings(), { protectedChannel: " Some_Channel " })
        .protectedChannel,
    ).toBe("some_channel");
    expect(() =>
      patchSettings(defaultSettings(), { protectedChannel: "bad channel" }),
    ).toThrow();
  });

  it("rehearsal is forced until onboarding completes, then saved", () => {
    const fresh = loadSettings({ rehearsal: false });
    expect(startupRehearsal(fresh)).toBe(true);
    expect(
      startupRehearsal(
        loadSettings({ rehearsal: false, onboardingComplete: true }),
      ),
    ).toBe(false);
    expect(
      startupRehearsal(
        loadSettings({ rehearsal: true, onboardingComplete: true }),
      ),
    ).toBe(true);
  });

  it("older stored modes gain new actions as their defaults", () => {
    const loaded = loadSettings({
      modes: { ...defaultSettings().modes, shield: "auto" },
    });
    expect(loaded.modes.shield).toBe("auto");
    expect(loaded.modes.mute).toBe("off");
    expect(loadSettings({ modes: undefined } as never).modes.cover).toBe(
      "auto",
    );
    expect(
      patchSettings(defaultSettings(), { modes: { shield: "auto" } }).modes
        .shield,
    ).toBe("auto");
  });
});

describe("Rehearsal", () => {
  it("practice chat uses the rehearsal module's terms and local OBS actions are real", async () => {
    const adapter = new RehearsalActions();
    const spike = vi.fn();
    const guard = new ChatGuard(adapter, () => {}, spike);
    guard.setTerms(PRACTICE_TERMS);
    await practiceChat(guard);
    expect(adapter.deleted).toHaveLength(4);
    expect(spike).toHaveBeenCalledTimes(1);
    const local = {
      cover: vi.fn(async () => {}),
      mute: vi.fn(async () => {}),
      unmute: vi.fn(async () => {}),
    };
    const actions = adapter.incidentActions(guard, local);
    await actions.cover();
    await actions.mute();
    await actions.unmute();
    expect(local.cover).toHaveBeenCalled();
    expect(local.mute).toHaveBeenCalled();
    expect(local.unmute).toHaveBeenCalled();
    expect(adapter.covered).toBe(true);
    await actions.shield();
    await actions.blocked([]);
    await actions.notice();
    expect(adapter.journal).toContain("shield practice action");
  });
});
