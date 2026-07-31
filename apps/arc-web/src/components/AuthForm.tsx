import React, { useState } from "react";

export interface AuthFormProps {
  readonly onSignIn: () => Promise<void>;
  readonly errorMessage?: string;
  readonly isLoading?: boolean;
}

export const AuthForm: React.FC<AuthFormProps> = ({
  onSignIn,
  errorMessage,
  isLoading = false,
}) => {
  const [localError, setLocalError] = useState("");

  const handleSignIn = async () => {
    setLocalError("");
    try {
      await onSignIn();
    } catch (err: unknown) {
      const allowedMessages = new Set(["Wallet sign in failed. Connect your wallet and try again."]);
      const message = err instanceof Error && allowedMessages.has(err.message)
        ? err.message
        : "Wallet sign in failed. Connect your wallet and try again.";
      setLocalError(message);
    }
  };

  const activeError = errorMessage || localError;

  return (
    <div className="card" style={{ maxWidth: "440px", margin: "3rem auto" }}>
      <h2 className="card-title" id="auth-title">
        Connect Wallet to AgentPay Arc
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
        Sign with an external EVM wallet to create your Arc session. This signature is for identity only and does not approve payments or grant access to your hosted Circle wallet.
      </p>

      {activeError && (
        <div className="alert alert-danger" id="auth-error-alert" role="alert">
          <span>{activeError}</span>
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        style={{ width: "100%", marginTop: "0.5rem" }}
        disabled={isLoading}
        id="wallet-sign-in-btn"
        onClick={() => void handleSignIn()}
      >
        {isLoading ? "Waiting for wallet..." : "Connect wallet & sign in"}
      </button>
    </div>
  );
};
