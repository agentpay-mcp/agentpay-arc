import React, { useState } from "react";
import type { SafeAccountInfo } from "../api.ts";

export interface DashboardProps {
  readonly account: SafeAccountInfo;
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
  onProvisionWallet,
  onPauseAccount,
  onResumeAccount,
  onWithdraw,
  isLoading = false,
  errorMessage,
  withdrawalResult,
}) => {
  const [withdrawDest, setWithdrawDest] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawConfirmed, setWithdrawConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  const isWalletReady = account.wallet.status === "LIVE" && Boolean(account.wallet.address);
  const isPaused = account.status === "PAUSED";

  const handleCopyAddress = () => {
    if (account.wallet.address) {
      navigator.clipboard.writeText(account.wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleWithdrawSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!withdrawDest.trim() || !withdrawAmount.trim() || !withdrawConfirmed) return;
    const idempotencyKey = crypto.randomUUID();
    onWithdraw(withdrawDest.trim(), withdrawAmount.trim(), idempotencyKey);
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
          <label className="form-label">Safe Public Wallet Address</label>
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
            100.00 <span style={{ fontSize: "1rem", color: "var(--text-muted)" }}>USDC</span>
          </div>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
            Funded balance represents your agent's total available payment capacity on Arc Testnet.
          </p>
        </div>

        {/* Activity & History */}
        <div className="card" id="activity-card">
          <h3 className="card-title">Recent Activity</h3>
          <ul style={{ listStyle: "none", fontSize: "0.875rem", color: "var(--text-muted)" }} id="activity-list">
            <li style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between" }}>
              <span>Account Claimed & Verified</span>
              <span className="status-badge status-live" style={{ fontSize: "0.7rem" }}>SUCCESS</span>
            </li>
            {isWalletReady && (
              <li style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between" }}>
                <span>SCA Wallet Provisioned</span>
                <span className="status-badge status-live" style={{ fontSize: "0.7rem" }}>LIVE</span>
              </li>
            )}
            {withdrawalResult && (
              <li style={{ padding: "0.6rem 0", display: "flex", justifyContent: "space-between" }}>
                <span>Withdrawal: {withdrawalResult.status}</span>
                <span className={`status-badge status-${withdrawalResult.reconciliationRequired ? "pending" : "live"}`} style={{ fontSize: "0.7rem" }}>
                  {withdrawalResult.reconciliationRequired ? "RECONCILING" : "COMPLETED"}
                </span>
              </li>
            )}
          </ul>
        </div>
      </div>

      {/* Confirmed Withdrawal Form */}
      {isWalletReady && (
        <div className="card" id="withdrawal-card">
          <h3 className="card-title">Withdraw Remaining Balance</h3>
          <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "1.25rem" }}>
            Withdraw USDC from your agent's hosted wallet to an external EVM address. Requires explicit confirmation.
          </p>

          {withdrawalResult && (
            <div className={`alert ${withdrawalResult.reconciliationRequired ? "alert-info" : "alert-success"}`} id="withdrawal-result-alert">
              <div>
                <strong>Withdrawal Outcome: {withdrawalResult.status}</strong>
                {withdrawalResult.transactionHash && <div>Tx Hash: {withdrawalResult.transactionHash}</div>}
                {withdrawalResult.reconciliationRequired && <div>Status is pending reconciliation with Arc network.</div>}
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
