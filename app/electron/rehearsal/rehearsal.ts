import type { GuardActions } from "../guard/chat-guard.js";
import type { IncidentActions, Incident } from "../incidents/engine.js";
import type { ChatGuard } from "../guard/chat-guard.js";

/** This adapter has no network capability: rehearsal cannot moderate real chat. */
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
  incidentActions(guard: ChatGuard): IncidentActions {
    return {
      cover: async () => {
        this.covered = true;
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
