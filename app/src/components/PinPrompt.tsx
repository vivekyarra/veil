import { useState } from "react";
import { call, useVeil } from "../store";
import { Modal } from "./Modal";

/** Asks for the vault PIN when a destructive vault action needs it. */
export function PinPrompt() {
  const request = useVeil((s) => s.pinRequest),
    set = useVeil((s) => s.set),
    busy = useVeil((s) => s.busy);
  const [pin, setPin] = useState(""),
    [error, setError] = useState("");
  if (!request) return null;
  const close = () => {
    setPin("");
    setError("");
    set({ pinRequest: null });
  };
  return (
    <Modal labelledBy="pin-title" onCancel={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await call(request.operation, {
            ...request.input,
            pin,
          });
          setPin("");
          if (result.ok) close();
          else setError(result.error ?? "Incorrect vault PIN");
        }}
      >
        <span className="eyebrow">CONFIRM WITH YOUR PIN</span>
        <h2 id="pin-title">{request.title}</h2>
        <p>
          Your vault was not unlocked in the last 30 seconds, so this needs your
          app PIN.
        </p>
        <label>
          Vault PIN
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={12}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            required
          />
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="danger" disabled={busy || pin.length < 6}>
            Confirm with PIN
          </button>
        </div>
      </form>
    </Modal>
  );
}
