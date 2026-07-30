import React from "react";

export interface HeaderProps {
  readonly userEmail?: string;
  readonly onSignOut?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ userEmail, onSignOut }) => {
  return (
    <header className="header-bar" role="banner">
      <a href="/" className="brand-logo" id="brand-logo">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" stroke="url(#logo_grad)" strokeWidth="2.5" />
          <path d="M8 12L11 15L16 9" stroke="url(#logo_grad)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <defs>
            <linearGradient id="logo_grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop stopColor="#00D2FF" />
              <stop offset="1" stopColor="#3A7BD5" />
            </linearGradient>
          </defs>
        </svg>
        <span>AgentPay Arc</span>
      </a>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span className="badge-network" id="network-badge">ARC-TESTNET</span>
        {userEmail && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }} id="user-email-display">
              {userEmail}
            </span>
            {onSignOut && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: "0.35rem 0.75rem", fontSize: "0.8rem" }}
                onClick={onSignOut}
                id="sign-out-btn"
              >
                Sign Out
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
};
