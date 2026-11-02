import type { ObsClient } from "../obs/client.js";
import type { Supervisor } from "../supervisor.js";
import type { Settings } from "../store/settings.js";
import { preflight } from "../preflight/preflight.js";
import { reply, text, type Commands } from "./dispatch.js";

export const COVER_SCENE = "VEIL Cover";
export const profileLevel = (profile: Settings["profile"]): number =>
  profile === "paranoid" ? 2 : profile === "off" ? 0 : 1;

interface ObsContext {
  obs: ObsClient;
  detector: Supervisor;
  settings(): Settings;
  persist(): void;
  /** A real file path OBS can read; never a path inside app.asar. */
  coverFile(): string;
  credentialPath(): string;
  detectorReady(): boolean;
  vaultCategories(): number;
  twitchReady(): boolean;
  eventsubConnected(): boolean;
}

export function obsCommands(ctx: ObsContext): Commands {
  const { obs } = ctx;
  return {
    "obs-connect": async (data) => {
      const settings = ctx.settings();
      settings.obsUrl = text(data.url, 200);
      await obs.connect(settings.obsUrl, text(data.password, 200));
      await obs.createCover(ctx.coverFile());
      ctx.persist();
    },
    "obs-scenes": async () =>
      reply((await obs.scenes()).filter((scene) => scene !== COVER_SCENE)),
    "obs-install": async (data) => {
      if (
        !Array.isArray(data.scenes) ||
        !data.scenes.length ||
        data.scenes.length > 200
      )
        throw new Error("Select scenes");
      const settings = ctx.settings();
      await obs.install(
        data.scenes.map((s) => text(s, 200)),
        ctx.credentialPath(),
        settings.delay,
        profileLevel(settings.profile),
        settings.sampleFps,
      );
    },
    preflight: async () => {
      const settings = ctx.settings();
      return reply(
        await preflight(
          obs,
          ctx.detector,
          settings.delay,
          settings.sampleFps,
          ctx.vaultCategories(),
          ctx.twitchReady(),
          ctx.eventsubConnected(),
        ),
      );
    },
  };
}
