import React, { useState } from "react";
import { ARC_AUTONOMY_CONSENT_VERSION } from "@agentpay-ai/shared-arc/arc-hosted-auth";

export interface ConsentModalProps {
  readonly onClaim: () => Promise<void>;
  readonly onSignOut?: () => void;
  readonly isLoading?: boolean;
  readonly errorMessage?: string;
}

export const ConsentModal: React.FC<ConsentModalProps> = ({
  onClaim,
  onSignOut,
  isLoading = false,
  errorMessage,
}) => {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="modal-overlay" id="consent-card" role="dialog" aria-labelledby="consent-modal-title">
      <div className="modal-content">
        <h2 className="card-title" id="consent-modal-title" style={{ fontSize: "1.35rem" }}>
          Autonomous Agent Wallet Consent
        </h2>
        <p style={{ color: "var(--text-muted)", fontSize: "0.95rem", marginTop: "0.5rem" }}>
          Before claiming your hosted Arc tenant and Circle SCA wallet for <span id="verified-wallet-session" style={{ color: "var(--text-main)", fontWeight: 600 }}>your verified wallet session</span>, please review the required autonomy consent policy:
        </p>

        <div className="consent-statement" id="autonomy-consent-text">
          <strong>Autonomy Consent Policy (Version: {ARC_AUTONOMY_CONSENT_VERSION}):</strong><br />
          The hosted wallet is controlled programmatically, the funded balance is the available agent budget, payments do not ask every time, and the user can pause and withdraw the remaining balance.
        </div>

        {errorMessage && (
          <div className="alert alert-danger" id="consent-error-alert">
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="form-group" style={{ marginTop: "1.5rem" }}>
          <label className="form-checkbox" htmlFor="consent-checkbox">
            <input
              type="checkbox"
              id="consent-checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              disabled={isLoading}
            />
            <span>
              I understand and agree to the <strong>{ARC_AUTONOMY_CONSENT_VERSION}</strong> programmatic autonomy policy.
            </span>
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1.5rem" }}>
          {onSignOut && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onSignOut}
              id="consent-sign-out-btn"
              disabled={isLoading}
            >
              Sign Out
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={!agreed || isLoading}
            onClick={onClaim}
            id="claim-account-btn"
          >
            {isLoading ? "Claiming..." : "Claim Hosted Account & Provision"}
          </button>
        </div>
      </div>
    </div>
  );
};
