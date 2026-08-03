import React, { useState } from "react";
import type { SafeAccountInfo, SafeActivityItem } from "../api.ts";
import { prepareWithdrawal } from "../withdrawal.ts";

export interface ConnectedClient {
  readonly oauthClientId: string;
  readonly canRead: boolean;
  readonly canSendPayments: boolean;
  readonly revoked: boolean;
}

export interface DashboardProps {
  readonly account: SafeAccountInfo;
  /** Delegated MCP clients and what each may currently do. */
  readonly clients?: readonly ConnectedClient[];
  readonly onSetClientPayment?: (oauthClientId: string, allowPayment: boolean) => Promise<void>;
  readonly onProvisionWallet: () => Promise<void>;
  readonly onPauseAccount: () => Promise<void>;
  readonly onResumeAccount: () => Promise<void>;
  readonly onWithdraw: (destination: string, amount: string, idempotencyKey: string) => Promise<void>;
  readonly isLoading?: boolean;
  readonly errorMessage?: string;
  readonly withdrawalResult?: {
    status: string;
    transactionHash?: string;
    reconciliationRequired: boolean;
  } | null;
}

export const Dashboard: React.FC<DashboardProps> = ({
  account,
  clients,
  onSetClientPayment,
  onProvisionWallet,
  onPauseAccount,
  onResumeAccount,
  onWithdraw,
  isLoading = false,
  errorMessage,
  withdrawalResult,
}) => {
  const [newClientId, setNewClientId] = useState("");
  const [withdrawDest, setWithdrawDest] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawConfirmed, setWithdrawConfirmed] = useState(false);
  const [withdrawValidationError, setWithdrawValidationError] = useState("");
  const [copied, setCopied] = useState(false);

  const isWalletReady = account.wallet.status === "LIVE" && Boolean(account.wallet.address);
  const isPaused = account.status === "PAUSED";
  const hasBalance = account.balanceUsdc !== undefined;
  const balanceDisplay = hasBalance ? account.balanceUsdc : "Balance projection unavailable";
  const activityList = account.activity;
  const withdrawalIsComplete =
    withdrawalResult?.status === "COMPLETED"
    && !withdrawalResult.reconciliationRequired;
  const withdrawalIsFailed =
    withdrawalResult?.status === "FAILED"
    && !withdrawalResult.reconciliationRequired;
  const withdrawalAlertClass = withdrawalIsComplete
    ? "alert-success"
    : withdrawalIsFailed
      ? "alert-danger"
      : "alert-info";

  const handleCopyAddress = () => {
    if (account.wallet.address) {
      navigator.clipboard.writeText(account.wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleWithdrawSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setWithdrawValidationError("");
    if (isPaused) {
      setWithdrawValidationError("Resume the account before requesting a withdrawal.");
      return;
    }

    if (!withdrawConfirmed) {
      setWithdrawValidationError("You must explicitly confirm the withdrawal.");
      return;
    }

    try {
      const prepared = prepareWithdrawal(withdrawDest, withdrawAmount);
      void onWithdraw(prepared.destination, prepared.amount, prepared.idempotencyKey);
    } catch (error: unknown) {
      setWithdrawValidationError(
        error instanceof Error
          ? error.message
          : "Unable to prepare a safe withdrawal. Please try again.",
      );
    }
  };

  return (
    <div className="container" id="dashboard-container">
      {errorMessage && (
        <div className="alert alert-danger" id="dashboard-error-alert" role="alert">
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Account & Wallet Overview */}
      <div className="card" id="account-status-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h2 className="card-title" id="wallet-card-title">
              Arc Agent Wallet
            </h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
              Circle Developer-Controlled SCA Wallet on Arc Testnet
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <span className={`status-badge status-${account.status.toLowerCase()}`} id="account-status-badge">
              Account: {account.status}
            </span>
            <span className={`status-badge status-${account.wallet.status.toLowerCase()}`} id="wallet-status-badge">
              SCA: {account.wallet.status}
            </span>
          </div>
        </div>

        <div style={{ marginTop: "1.5rem" }}>
          <label className="form-label" htmlFor="wallet-address-display">Safe Public Wallet Address</label>
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <div className="code-box" style={{ flex: 1, marginTop: 0 }} id="wallet-address-display">
              {account.wallet.address || "Wallet provisioning pending..."}
            </div>
            {isWalletReady && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCopyAddress}
                id="copy-address-btn"
                style={{ height: "42px", padding: "0 1rem" }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: "1rem", marginTop: "1.5rem", flexWrap: "wrap" }}>
          {!isWalletReady && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onProvisionWallet}
              disabled={isLoading || account.wallet.status === "PROVISIONING"}
              id="provision-wallet-btn"
            >
              {isLoading || account.wallet.status === "PROVISIONING"
                ? "Provisioning SCA Wallet..."
                : "Provision SCA Wallet"}
            </button>
          )}

          {isWalletReady && !isPaused && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={onPauseAccount}
              disabled={isLoading}
              id="pause-account-btn"
            >
              Pause Account
            </button>
          )}

          {isWalletReady && isPaused && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onResumeAccount}
              disabled={isLoading}
              id="resume-account-btn"
            >
              Resume Account
            </button>
          )}
        </div>
      </div>

      <div className="grid-2col">
        {/* Available Agent Budget */}
        <div className="card" id="budget-card">
          <h3 className="card-title">Available Agent Budget</h3>
          <div style={{ fontSize: "2.2rem", fontWeight: 700, color: "var(--primary-accent)", margin: "0.75rem 0" }} id="budget-amount">
            {balanceDisplay}
            {hasBalance && <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}> USDC</span>}
          </div>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
            Funded balance represents your agent's total available payment capacity on Arc Testnet.
          </p>
        </div>

        {/* Activity & History */}
        <div className="card" id="activity-card">
          <h3 className="card-title">Recent Activity</h3>
          {activityList === undefined ? (
            <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginTop: "0.75rem" }} id="unloaded-activity-msg">
              Activity projection unavailable.
            </p>
          ) : activityList.length === 0 ? (
            <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginTop: "0.75rem" }} id="empty-activity-msg">
              No recent transactions recorded for this account.
            </p>
          ) : (
            <ul style={{ listStyle: "none", fontSize: "0.875rem", color: "var(--text-muted)" }} id="activity-list">
              {activityList.map((item: SafeActivityItem) => (
                <li key={item.id} style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between" }}>
                  <span>{item.type} {item.amount ? `(${item.amount} USDC)` : ""}</span>
                  <span className={`status-badge status-${item.status.toLowerCase()}`} style={{ fontSize: "0.7rem" }}>
                    {item.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Confirmed Withdrawal Form */}
      {isWalletReady && (
        <div className="card" id="withdrawal-card">
          <h3 className="card-title">Withdraw Remaining Balance</h3>
          <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "1.25rem" }}>
            Withdraw USDC from your agent's hosted wallet to an external EVM address. Requires explicit confirmation.
          </p>

          {withdrawValidationError && (
            <div className="alert alert-danger" id="withdrawal-input-error-alert" role="alert">
              <span>{withdrawValidationError}</span>
            </div>
          )}

          {withdrawalResult && (
            <div className={`alert ${withdrawalAlertClass}`} id="withdrawal-result-alert">
              <div>
                <strong>Withdrawal Outcome: {withdrawalResult.status}</strong>
                {withdrawalResult.transactionHash && <div>Tx Hash: {withdrawalResult.transactionHash}</div>}
                {!withdrawalIsComplete && !withdrawalIsFailed && <div>Status is pending reconciliation with Arc network.</div>}
              </div>
            </div>
          )}

          <form onSubmit={handleWithdrawSubmit} id="withdrawal-form">
            <div className="grid-2col">
              <div className="form-group">
                <label className="form-label" htmlFor="withdraw-dest">
                  Destination EVM Address (0x...)
                </label>
                <input
                  id="withdraw-dest"
                  type="text"
                  className="form-input"
                  value={withdrawDest}
                  onChange={(e) => setWithdrawDest(e.target.value)}
                  placeholder="0x1234...5678"
                  disabled={isLoading || isPaused}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="withdraw-amount">
                  Amount (USDC)
                </label>
                <input
                  id="withdraw-amount"
                  type="text"
                  className="form-input"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  placeholder="10.00"
                  disabled={isLoading || isPaused}
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-checkbox" htmlFor="withdraw-confirm-checkbox">
                <input
                  type="checkbox"
                  id="withdraw-confirm-checkbox"
                  checked={withdrawConfirmed}
                  onChange={(e) => setWithdrawConfirmed(e.target.checked)}
                  disabled={isLoading || isPaused}
                />
                <span>I explicitly confirm withdrawal of the specified amount to the destination address.</span>
              </label>
            </div>

            <button
              type="submit"
              className="btn btn-secondary"
              disabled={isLoading || isPaused || !withdrawConfirmed || !withdrawDest || !withdrawAmount}
              id="submit-withdraw-btn"
            >
              {isLoading ? "Executing Withdrawal..." : "Confirm & Withdraw USDC"}
            </button>
          </form>
        </div>
      )}

      {/*
        The owner's view of who they have delegated to, and the control to
        change it. Without this the consent screen would point at an account
        setting that does not exist -- the gap that made an earlier version of
        that screen describe a control nobody could find.
      */}
      {clients !== undefined && (
        <div className="card" id="connected-clients-card">
          <h3 className="card-title">Connected agents</h3>
          {clients.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }} id="no-connected-clients">
              No agent has been granted payment access yet. Agents you authorize can read your
              balance; sending payments is granted here, separately.
            </p>
          ) : (
            <ul style={{ listStyle: "none" }} id="connected-clients-list">
              {clients.map((client) => (
                <li
                  key={client.oauthClientId}
                  style={{ padding: "0.75rem 0", borderBottom: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <div style={{ fontSize: "0.85rem", color: "var(--text-dim)", wordBreak: "break-all" }}>
                    {client.oauthClientId}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.4rem" }}>
                    <span
                      style={{ fontSize: "0.9rem" }}
                      id={`client-capability-${client.oauthClientId}`}
                    >
                      {client.canSendPayments ? "Can send payments" : "Read-only"}
                    </span>
                    {onSetClientPayment && (
                      <button
                        type="button"
                        className={client.canSendPayments ? "btn btn-danger" : "btn btn-primary"}
                        style={{ padding: "0.3rem 0.75rem", fontSize: "0.85rem" }}
                        id={`client-toggle-${client.oauthClientId}`}
                        onClick={() =>
                          void onSetClientPayment(client.oauthClientId, !client.canSendPayments)
                        }
                      >
                        {client.canSendPayments ? "Remove payment access" : "Allow payments"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/*
            A client that has only ever read has no grant row, so it cannot
            appear in the list above — and without this it could never receive
            its first payment grant from the very screen the consent page points
            at. Entering the ID it was issued is the bootstrap.
          */}
          {onSetClientPayment && (
            <form
              id="grant-client-form"
              style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
              onSubmit={(event) => {
                event.preventDefault();
                const id = newClientId.trim();
                if (!id) return;
                void onSetClientPayment(id, true).then(() => setNewClientId(""));
              }}
            >
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, minWidth: "16rem" }}
                id="grant-client-id-input"
                placeholder="OAuth client ID from the agent you authorized"
                value={newClientId}
                onChange={(event) => setNewClientId(event.target.value)}
              />
              <button type="submit" className="btn btn-primary" id="grant-client-submit">
                Allow payments
              </button>
            </form>
          )}
        </div>
      )}

      {/* Chat-First MCP Connection Instructions */}
      <div className="card" id="mcp-instructions-card">
        <h3 className="card-title">Chat-First MCP Connection</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}>
          Connect your AI agent (Claude Desktop, Cursor, or any Streamable HTTP MCP client) to your hosted Arc wallet:
        </p>

        <div className="code-box" id="mcp-url-display">
          https://mcp.arc.agentpay.site/mcp
        </div>

        <p style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginTop: "0.75rem" }}>
          Clients will automatically discover authentication via RFC 9728 Protected Resource Metadata and complete PKCE OAuth login.
        </p>
      </div>
    </div>
  );
};
