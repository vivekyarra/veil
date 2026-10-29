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
        this.journal.push("shield simulated");
      },
      blocked: async () => {
        this.journal.push("blocked terms simulated");
      },
      notice: async () => {
        this.journal.push("neutral notice simulated");
      },
      discord: async (_incident: Incident) => {
        this.journal.push("metadata webhook simulated");
      },
      clips: async () => [
        {
          id: "SyntheticRehearsalClip",
          url: "https://clips.twitch.tv/SyntheticRehearsalClip",
          created_at: new Date().toISOString(),
          creator_name: "synthetic_viewer",
          thumbnail_url: "",
          vod_offset: 74,
          video_id: "synthetic",
        },
      ],
    };
  }
}
export const SCENARIOS = {
  email: {
    title: "A quiet inbox",
    label: "Email",
    value: "synthetic.viewer@example.com",
  },
  dm: {
    title: "A private conversation",
    label: "Address",
    value: "123 Synthetic Maple Street",
  },
  terminal: {
    title: "Developer terminal",
    label: "Credential",
    value: "api_key=synthetic_demo_only_0123456789",
  },
  form: {
    title: "Shipping details",
    label: "Contact",
    value: "+1 202 555 0100",
  },
} as const;
