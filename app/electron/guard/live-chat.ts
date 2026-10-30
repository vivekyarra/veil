import type { ChatMessage } from "../twitch/eventsub.js";
import type { ChatGuard } from "./chat-guard.js";

/** Rehearsal chat stays separate from messages received from Twitch. */
export function liveChatHandler(
  connectedMode: () => boolean,
  guard: ChatGuard,
): (message: ChatMessage) => void {
  return (message) => {
    if (connectedMode()) void guard.receive(message);
  };
}
