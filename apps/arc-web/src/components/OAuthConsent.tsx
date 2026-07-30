import React, { useEffect, useState } from "react";
import { uuidV4Schema } from "@agentpay-ai/shared-arc/batch-payout";
import {
  fetchOAuthAuthorizationDetails,
  approveOAuthAuthorization,
  denyOAuthAuthorization,
} from "../supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface OAuthConsentProps {
  readonly supabaseClient: SupabaseClient;
  readonly authorizationId?: string;
  readonly initialDetails?: { clientName: string; redirectUri: string; scopes: readonly string[] } | null;
  readonly initialErrorMsg?: string;
  readonly initialLoading?: boolean;
}

export const OAuthConsent: React.FC<OAuthConsentProps> = ({
  supabaseClient,
  authorizationId,
  initialDetails = null,
  initialErrorMsg = "",
  initialLoading = true,
}) => {
  const [details, setDetails] = useState<{ clientName: string; redirectUri: string; scopes: readonly string[] } | null>(initialDetails);
  const [errorMsg, setErrorMsg] = useState(initialErrorMsg);
  const [isLoading, setIsLoading] = useState(initialLoading);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      setErrorMsg("");

      if (!authorizationId) {
        setErrorMsg("Missing required authorization_id parameter.");
        setIsLoading(false);
        return;
      }

      const parseResult = uuidV4Schema.safeParse(authorizationId);
      if (!parseResult.success) {
        setErrorMsg("Invalid authorization_id format. Must be a valid UUID.");
        setIsLoading(false);
        return;
      }

      try {
        const info = await fetchOAuthAuthorizationDetails(supabaseClient, authorizationId);
        if (info.kind === "redirect") {
          window.location.href = info.redirectUrl;
          return;
        }
        setDetails({
          clientName: info.clientName,
          redirectUri: info.redirectUri,
          scopes: info.scopes,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to load OAuth authorization request.";
        setErrorMsg(msg);
      } finally {
        setIsLoading(false);
      }
    }
    void load();
  }, [authorizationId, supabaseClient]);

  const handleApprove = async () => {
    if (!authorizationId) return;
    setIsSubmitting(true);
    setErrorMsg("");
    try {
      const redirectUrl = await approveOAuthAuthorization(supabaseClient, authorizationId);
      window.location.href = redirectUrl;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to approve OAuth authorization.";
      setErrorMsg(msg);
      setIsSubmitting(false);
    }
  };

  const handleDeny = async () => {
    if (!authorizationId) return;
    setIsSubmitting(true);
    setErrorMsg("");
    try {
      const redirectUrl = await denyOAuthAuthorization(supabaseClient, authorizationId);
      window.location.href = redirectUrl;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to deny OAuth authorization.";
      setErrorMsg(msg);
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="card" style={{ maxWidth: "520px", margin: "4rem auto", textAlign: "center" }} id="oauth-loading">
        <h2 className="card-title" style={{ justifyContent: "center" }}>Loading Authorization Request...</h2>
      </div>
    );
  }

  if (errorMsg || !details) {
    return (
      <div className="card" style={{ maxWidth: "520px", margin: "4rem auto" }} id="oauth-error">
        <h2 className="card-title" style={{ color: "var(--danger-color)" }}>OAuth Authorization Error</h2>
        <div className="alert alert-danger" id="oauth-error-alert">
          <span>{errorMsg || "Invalid or expired authorization request."}</span>
        </div>
        <a href="/" className="btn btn-secondary" style={{ width: "100%" }} id="oauth-return-home">
          Return to Dashboard
        </a>
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: "540px", margin: "4rem auto" }} id="oauth-consent-card">
      <h2 className="card-title" id="oauth-title">
        Authorize Application Access
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.95rem", marginBottom: "1.5rem" }}>
        An external AI client is requesting authorization to connect to your AgentPay Arc account:
      </p>

      <div style={{ background: "rgba(255,255,255,0.04)", padding: "1.25rem", borderRadius: "var(--radius-sm)", marginBottom: "1.5rem" }}>
        <div style={{ fontWeight: 600, fontSize: "1.1rem", color: "var(--primary-accent)" }} id="oauth-client-name">
          {details.clientName}
        </div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginTop: "0.25rem" }} id="oauth-redirect-uri">
          Redirect URI: {details.redirectUri}
        </div>
      </div>

      <div style={{ marginBottom: "1.5rem" }}>
        <label className="form-label">Requested Standard Scopes</label>
        <ul style={{ listStyle: "none", fontSize: "0.9rem" }} id="oauth-scopes-list">
          {details.scopes.map((scope) => (
            <li key={scope} style={{ padding: "0.4rem 0", color: "var(--text-main)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ color: "var(--success-color)" }}>✓</span> {scope}
            </li>
          ))}
        </ul>
      </div>

      <div style={{ display: "flex", gap: "1rem" }}>
        <button
          type="button"
          className="btn btn-danger"
          style={{ flex: 1 }}
          onClick={handleDeny}
          disabled={isSubmitting}
          id="oauth-deny-btn"
        >
          {isSubmitting ? "Processing..." : "Deny Access"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          style={{ flex: 1 }}
          onClick={handleApprove}
          disabled={isSubmitting}
          id="oauth-approve-btn"
        >
          {isSubmitting ? "Redirecting..." : "Approve & Connect"}
        </button>
      </div>
    </div>
  );
};
