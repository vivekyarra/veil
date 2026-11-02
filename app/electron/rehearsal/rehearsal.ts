import { randomUUID } from "node:crypto";
import type { GuardActions } from "../guard/chat-guard.js";
import type { IncidentActions, Incident } from "../incidents/engine.js";
import type { ChatGuard } from "../guard/chat-guard.js";

/** Synthetic terms the practice chat guard watches for. */
export const PRACTICE_TERMS = [
  { text: "123 Main St", category: "address" },
  { text: "Maple Academy", category: "school" },
];
/** Local OBS actions that rehearsal performs for real when OBS is connected. */
interface LocalActions {
  cover(): Promise<void>;
  mute(): Promise<void>;
  unmute(): Promise<void>;
}

/**
 * Twitch actions are mocked: rehearsal cannot moderate real chat. Local OBS
 * actions (cover, mute) are real when supplied, so panic is always safe.
 */
export class RehearsalActions implements GuardActions {
  deleted: string[] = [];
  timeouts: string[] = [];
  covered = false;
  journal: string[] = [];
  async deleteMessage(id: string): Promise<void> {
    this.deleted.push(id);
  }
  async timeout(id: string): Promise<void> {
    this.timeouts.push(id);
  }
  incidentActions(guard: ChatGuard, local?: LocalActions): IncidentActions {
    return {
      cover: async () => {
        this.covered = true;
        await local?.cover();
      },
      mute: async () => {
        this.journal.push("mute practice action");
        await local?.mute();
      },
      unmute: async () => {
        this.journal.push("unmute practice action");
        await local?.unmute();
      },
      guard: async (terms) => {
        guard.addSessionTerms(terms);
      },
      retroactive: () => guard.retroactive(),
      marker: async (id) => ({
        id: `rehearsal-${id}`,
        created_at: new Date().toISOString(),
        position_seconds: 74,
        description: `VEIL incident #${id}`,
      }),
      shield: async () => {
        this.journal.push("shield practice action");
      },
      blocked: async () => {
        this.journal.push("blocked terms practice action");
      },
      notice: async () => {
        this.journal.push("neutral notice practice action");
      },
      discord: async (_incident: Incident) => {
        this.journal.push("metadata webhook practice action");
      },
      clips: async () => [
        {
          id: "LocalPracticeClip",
          url: "https://clips.twitch.tv/LocalPracticeClip",
          created_at: new Date().toISOString(),
          creator_name: "practice_viewer",
          thumbnail_url: "",
          vod_offset: 74,
          video_id: "local-practice",
        },
      ],
    };
  }
}
export const SCENARIOS = {
  email: {
    title: "A quiet inbox",
    label: "Email",
    value: "practice.viewer@example.com",
  },
  dm: {
    title: "A private conversation",
    label: "Address",
    value: "123 Maple Street",
  },
  terminal: {
    title: "Developer terminal",
    label: "Credential",
    value: "api_key=practice_only_0123456789abcdef",
  },
  form: {
    title: "Shipping details",
    label: "Contact",
    value: "+1 202 555 0100",
  },
} as const;
/** Synthetic practice chat: three viewers repeat a practice address. */
export async function practiceChat(guard: ChatGuard): Promise<void> {
  for (let i = 0; i < 5; i++)
    await guard.receive({
      id: randomUUID(),
      userId: "practice-" + (i % 3),
      login: "viewer_" + (i % 3),
      text: i === 0 ? "hello everyone" : "1 2 3 m4in st",
      timestamp: Date.now(),
      privileged: false,
    });
}
