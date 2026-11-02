import type { Category, Vault } from "../vault/vault.js";
import type { Helix } from "../twitch/helix.js";
import { optionalPin, reply, text, type Commands } from "./dispatch.js";

interface VaultContext {
  vault: Vault;
  helix(): Helix | undefined;
  /** Push terms to the chat guards and the detector. */
  sync(): Promise<void>;
  notify(): void;
}

export function vaultCommands(ctx: VaultContext): Commands {
  const { vault } = ctx;
  return {
    "vault-add": async (data) => {
      vault.add(text(data.text), text(data.category, 20) as Category);
      await ctx.sync();
    },
    "vault-edit": async (data) => {
      vault.edit(
        text(data.id, 50),
        text(data.text),
        text(data.category, 20) as Category,
      );
      await ctx.sync();
    },
    "vault-import": async (data) => {
      const terms = text(data.text, 20000)
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (
        terms.some((t) => t.length > 500) ||
        terms.length + vault.list().length > 1000
      )
        throw new Error("Import exceeds vault limits");
      for (const term of terms)
        vault.add(term, text(data.category, 20) as Category);
      await ctx.sync();
    },
    "vault-pin": (data) => vault.setPin(text(data.pin, 12)),
    "vault-unlock": (data) => vault.unlock(text(data.pin, 12)),
    "vault-reveal": (data) => reply(vault.reveal(text(data.id, 50))),
    "vault-delete": async (data) => {
      const id = text(data.id, 50),
        pin = optionalPin(data.pin),
        entry = vault.terms().find((e) => e.id === id);
      vault.authorize(pin, "delete a term");
      if (entry?.blockedTermId) {
        const helix = ctx.helix();
        if (!helix)
          throw new Error("Reconnect Twitch before removing an opted-in term");
        await helix.removeBlockedTerm(entry.blockedTermId);
      }
      vault.remove(id, pin);
      await ctx.sync();
    },
    "vault-optin": async (data) => {
      const helix = ctx.helix();
      if (!helix) throw new Error("Connect Twitch first");
      const id = text(data.id, 50),
        entry = vault.terms().find((e) => e.id === id);
      if (!entry) throw new Error("Entry missing");
      if (data.confirm !== true)
        throw new Error(
          "Explicit confirmation required: moderators can read Twitch blocked terms",
        );
      if (entry.blockedTermId) {
        await helix.removeBlockedTerm(entry.blockedTermId);
        vault.markOptIn(id, undefined);
      } else {
        const result = await helix.blockedTerm(entry.text);
        vault.markOptIn(id, result.data[0].id);
      }
      ctx.notify();
    },
    "vault-wipe": async (data) => {
      if (data.confirm !== true) throw new Error("Confirm vault wipe");
      if (vault.terms().some((e) => e.blockedTermId))
        throw new Error("Remove opted-in Twitch blocked terms before wiping");
      vault.wipe(optionalPin(data.pin));
      await ctx.sync();
    },
  };
}
