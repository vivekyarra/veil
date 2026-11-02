import { useEffect, useState } from "react";
import { run, useVeil, withPin } from "../store";

export const CATEGORIES = [
  "name",
  "address",
  "city",
  "phone",
  "email",
  "family",
  "school",
  "plate",
  "custom",
];

export function NeverShow() {
  const state = useVeil((s) => s.state),
    busy = useVeil((s) => s.busy);
  const [term, setTerm] = useState(""),
    [editingId, setEditingId] = useState<string | null>(null),
    [importText, setImportText] = useState(""),
    [category, setCategory] = useState("name"),
    [pin, setPin] = useState(""),
    [revealed, setRevealed] = useState<Record<string, string>>({});
  // Revealed terms hide again after 30 seconds, matching the vault unlock.
  useEffect(() => {
    const timer = setTimeout(() => setRevealed({}), 30000);
    return () => clearTimeout(timer);
  }, [revealed]);
  const reveal = async (id: string) => {
    const value = await run("vault-reveal", { id });
    return typeof value === "string" ? value : undefined;
  };
  return (
    <div className="two-columns">
      <section className="panel pad">
        <h2>Never Show vault</h2>
        <p className="subtle">
          Entries are masked until you unlock them with your app PIN.
        </p>
        {state.vault.length === 0 && (
          <div className="empty-state">
            <span aria-hidden="true">◇</span>
            <h3>Keep your boundaries close.</h3>
            <p>Add a name, address or another private term.</p>
          </div>
        )}
        {state.vault.map((entry) => (
          <div className="vault-row" key={entry.id}>
            <span className="vault-category">{entry.category}</span>
            <strong>{revealed[entry.id] ?? "•••• •••• ••••"}</strong>
            <button
              aria-label={"Reveal " + entry.category}
              onClick={async () => {
                const value = await reveal(entry.id);
                if (value) setRevealed((v) => ({ ...v, [entry.id]: value }));
              }}
            >
              Reveal
            </button>
            <button
              aria-label={"Edit " + entry.category}
              onClick={async () => {
                const value = await reveal(entry.id);
                if (value) {
                  setTerm(value);
                  setCategory(entry.category);
                  setEditingId(entry.id);
                }
              }}
            >
              Edit
            </button>
            <button
              aria-label={"Delete " + entry.category}
              onClick={() =>
                void withPin(
                  `Delete this ${entry.category} term?`,
                  "vault-delete",
                  {
                    id: entry.id,
                  },
                )
              }
            >
              Delete
            </button>
            <label className="check">
              <input
                type="checkbox"
                checked={entry.optedIn}
                onChange={() => {
                  if (
                    confirm(
                      "Twitch moderators can read this term in blocked terms. Continue?",
                    )
                  )
                    void run("vault-optin", { id: entry.id, confirm: true });
                }}
              />
              Share as blocked term
            </label>
          </div>
        ))}
        <div className="warning">
          Blocked terms are separate: opting in sends the term to Twitch, where
          moderators can read it.
        </div>
        <button
          className="danger-text"
          onClick={() => {
            if (confirm("Wipe your local vault? This cannot be undone."))
              void withPin("Wipe the whole vault?", "vault-wipe", {
                confirm: true,
              });
          }}
        >
          Wipe local vault
        </button>
      </section>
      <section className="panel pad">
        <h2>{editingId ? "Edit private term" : "Add a private term"}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(editingId ? "vault-edit" : "vault-add", {
              id: editingId,
              text: term,
              category,
            }).then(() => {
              setTerm("");
              setEditingId(null);
            });
          }}
        >
          <label>
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Private term
            <input
              type="password"
              autoComplete="off"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              maxLength={500}
              required
            />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy}>
              {editingId ? "Save private term" : "Add to vault"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setTerm("");
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
        </form>
        <label>
          Import terms (one per line; concealed while typing)
          <textarea
            className="private-input"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            autoComplete="off"
            maxLength={20000}
          />
        </label>
        <button
          onClick={() =>
            void run("vault-import", { text: importText, category }).then(() =>
              setImportText(""),
            )
          }
        >
          Import to selected category
        </button>
        <hr />
        <h3>{state.hasPin ? "Unlock for 30 seconds" : "Set your app PIN"}</h3>
        <label>
          6–12 digit PIN
          <input
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            maxLength={12}
            autoComplete="off"
          />
        </label>
        <button
          className="secondary"
          onClick={() =>
            void run(state.hasPin ? "vault-unlock" : "vault-pin", { pin }).then(
              () => setPin(""),
            )
          }
        >
          {state.hasPin ? "Unlock vault" : "Set PIN"}
        </button>
      </section>
    </div>
  );
}
