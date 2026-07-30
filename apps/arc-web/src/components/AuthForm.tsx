import React, { useState } from "react";

export interface AuthFormProps {
  readonly onSignIn: (email: string, pass: string) => Promise<void>;
  readonly onSignUp: (email: string, pass: string) => Promise<void>;
  readonly errorMessage?: string;
  readonly isLoading?: boolean;
}

export const AuthForm: React.FC<AuthFormProps> = ({
  onSignIn,
  onSignUp,
  errorMessage,
  isLoading = false,
}) => {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError("");
    if (!email.trim() || !password.trim()) {
      setLocalError("Email and password are required.");
      return;
    }

    try {
      if (mode === "signin") {
        await onSignIn(email.trim(), password.trim());
      } else {
        await onSignUp(email.trim(), password.trim());
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Authentication failed.";
      setLocalError(msg);
    }
  };

  const activeError = errorMessage || localError;

  return (
    <div className="card" style={{ maxWidth: "440px", margin: "3rem auto" }}>
      <h2 className="card-title" id="auth-title">
        {mode === "signin" ? "Sign In to AgentPay Arc" : "Create Arc Account"}
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
        {mode === "signin"
          ? "Access your hosted Circle SCA agent wallet on Arc Testnet."
          : "Register to claim your dedicated Circle SCA agent wallet."}
      </p>

      {activeError && (
        <div className="alert alert-danger" id="auth-error-alert" role="alert">
          <span>{activeError}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} id="auth-form" noValidate>
        <div className="form-group">
          <label className="form-label" htmlFor="auth-email">
            Email Address
          </label>
          <input
            id="auth-email"
            type="email"
            className="form-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="agent@example.com"
            disabled={isLoading}
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="auth-password">
            Password
          </label>
          <input
            id="auth-password"
            type="password"
            className="form-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
            disabled={isLoading}
            required
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "100%", marginTop: "0.5rem" }}
          disabled={isLoading}
          id="auth-submit-btn"
        >
          {isLoading
            ? "Processing..."
            : mode === "signin"
            ? "Sign In"
            : "Create Account & Continue"}
        </button>
      </form>

      <div style={{ marginTop: "1.5rem", textAlign: "center", fontSize: "0.875rem", color: "var(--text-muted)" }}>
        {mode === "signin" ? (
          <span>
            Don't have an account?{" "}
            <button
              type="button"
              id="switch-to-signup"
              onClick={() => {
                setMode("signup");
                setLocalError("");
              }}
              style={{ background: "none", border: "none", color: "var(--primary-accent)", cursor: "pointer", fontWeight: 600 }}
            >
              Sign Up
            </button>
          </span>
        ) : (
          <span>
            Already have an account?{" "}
            <button
              type="button"
              id="switch-to-signin"
              onClick={() => {
                setMode("signin");
                setLocalError("");
              }}
              style={{ background: "none", border: "none", color: "var(--primary-accent)", cursor: "pointer", fontWeight: 600 }}
            >
              Sign In
            </button>
          </span>
        )}
      </div>
    </div>
  );
};
