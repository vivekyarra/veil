import { useEffect, useState } from "react";
import { call, useVeil } from "../store";
import { ACTIONS } from "../format";
import type { Action } from "../types";
import { Modal } from "./Modal";

/** Approval prompt for "ask" actions. Unanswered prompts decline. */
export function AskModal() {
  const ask = useVeil((s) => s.ask),
    set = useVeil((s) => s.set);
  const [remaining, setRemaining] = useState(10);
  useEffect(() => {
    if (!ask) return;
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((ask.expires - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 200);
    return () => clearInterval(timer);
  }, [ask]);
  if (!ask) return null;
  const answer = (yes: boolean) => {
    void call("ask", { id: ask.id, yes });
    set({ ask: null });
  };
  const meta = ACTIONS[ask.action as Action];
  return (
    <Modal
      role="alertdialog"
      labelledBy="ask-title"
      onCancel={() => answer(false)}
    >
      <span className="eyebrow">YOUR CALL</span>
      <h2 id="ask-title">Allow {ask.action}?</h2>
      <p>
        {ask.action === "blocked"
          ? "This sends private text to Twitch blocked terms, readable by moderators."
          : (meta?.detail ??
            "This action will run on your connected services.")}
      </p>
      <div className="countdown" aria-hidden="true">
        <i style={{ width: remaining * 10 + "%" }} />
      </div>
      <p>Defaults to No in {remaining} seconds.</p>
      <div className="button-row">
        <button autoFocus className="secondary" onClick={() => answer(false)}>
          No, keep it off
        </button>
        <button className="primary" onClick={() => answer(true)}>
          Allow action
        </button>
      </div>
    </Modal>
  );
}
