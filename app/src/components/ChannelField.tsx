import { useState } from "react";
import { saveSettings, useVeil } from "../store";

/**
 * Protected channel (moderator mode). Saving validates moderator access with
 * Twitch, so the backend's error is shown right under the field.
 */
export function ChannelField() {
  const state = useVeil((s) => s.state),
    busy = useVeil((s) => s.busy);
  const [value, setValue] = useState(state.settings.protectedChannel),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const own = !state.settings.protectedChannel;
  return (
    <form
      className="channel-field"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaved(false);
        const result = await saveSettings({ protectedChannel: value.trim() });
        setError(result.ok ? "" : (result.error ?? "Could not verify channel"));
        setSaved(result.ok);
      }}
    >
      <label>
        Channel to protect
        <span className="input-prefix">
          <span aria-hidden="true">twitch.tv/</span>
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError("");
              setSaved(false);
            }}
            maxLength={25}
            placeholder="leave empty for your own channel"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby="channel-help"
          />
        </span>
      </label>
      <p id="channel-help" className="fine-print">
        Moderators can run VEIL for a streamer: sign in with your own Twitch
        account, enter the streamer’s channel, and VEIL checks that you moderate
        it. Leave empty to protect your own channel.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button className="secondary" disabled={busy}>
          Save channel
        </button>
        <span className="field-status">
          {saved
            ? "Saved and verified."
            : own
              ? "Protecting your own channel."
              : `Protecting #${state.settings.protectedChannel}${state.channel.moderating ? " as moderator" : ""}.`}
        </span>
      </div>
    </form>
  );
}
