import { PAGES, useVeil } from "../store";
import { Icon, ShieldMark } from "./Icon";

export function Sidebar() {
  const page = useVeil((s) => s.page),
    go = useVeil((s) => s.go),
    state = useVeil((s) => s.state);
  const open = state.incidents.filter((i) => i.state !== "closed").length;
  return (
    <aside className="sidebar">
      <a
        href="#"
        className="brand"
        onClick={(e) => {
          e.preventDefault();
          go("Dashboard");
        }}
        aria-label="VEIL home"
      >
        <ShieldMark size={26} />
        VEIL
      </a>
      <div className="nav-label">YOUR PRIVATE SIDE</div>
      <nav aria-label="Main">
        {PAGES.map((section) => (
          <button
            key={section}
            className={page === section ? "active" : ""}
            aria-current={page === section ? "page" : undefined}
            onClick={() => go(section)}
          >
            <Icon kind={section} />
            {section}
            {section === "Incidents" && state.incidents.length > 0 && (
              <small className={open ? "hot" : ""}>
                {state.incidents.length}
              </small>
            )}
            {section === "Onboarding" && !state.onboardingComplete && (
              <i className="nav-dot" aria-hidden="true" />
            )}
          </button>
        ))}
      </nav>
      <div className="privacy-note">
        <strong>What’s yours stays yours.</strong>
        <p>Detection runs on this computer. Your vault stays private.</p>
        <span className="local-label">● LOCAL INFERENCE</span>
      </div>
      <button className="profile" onClick={() => go("Settings")}>
        <span className="avatar" aria-hidden="true">
          {(state.channel.login[0] ?? "V").toUpperCase()}
        </span>
        <span>
          {state.channel.login ? "#" + state.channel.login : "Your channel"}
          <small>
            {state.channel.moderating
              ? "Moderator mode"
              : state.rehearsal
                ? "Rehearsal mode"
                : "Connected mode"}
          </small>
        </span>
      </button>
    </aside>
  );
}
