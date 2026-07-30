import React, { useEffect, useState, useCallback } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getPublicConfig, type PublicConfig } from "./config.ts";
import { getSupabaseClient } from "./supabase.ts";
import {
  fetchHostedAccount,
  claimHostedAccount,
  provisionWallet,
  pauseHostedAccount,
  resumeHostedAccount,
  withdrawHostedAccount,
  ArcApiError,
  type SafeAccountInfo,
} from "./api.ts";
import { Header } from "./components/Header.tsx";
import { AuthForm } from "./components/AuthForm.tsx";
import { ConsentModal } from "./components/ConsentModal.tsx";
import { Dashboard } from "./components/Dashboard.tsx";
import { OAuthConsent } from "./components/OAuthConsent.tsx";

export interface AppProps {
  readonly config?: PublicConfig;
  readonly supabaseClient?: SupabaseClient;
  readonly customFetch?: typeof fetch;
}

export const App: React.FC<AppProps> = ({ config, supabaseClient, customFetch }) => {
  const activeConfig = config ?? getPublicConfig();
  const supabase = supabaseClient ?? getSupabaseClient(activeConfig, customFetch);

  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<SafeAccountInfo | null>(null);
  const [isUnclaimed, setIsUnclaimed] = useState(false);
  const [accountFetchError, setAccountFetchError] = useState("");
  const [isInitializing, setIsInitializing] = useState(true);
  const [isFetchingAccount, setIsFetchingAccount] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [withdrawalResult, setWithdrawalResult] = useState<{
    status: string;
    transactionHash?: string;
    reconciliationRequired: boolean;
  } | null>(null);

  const searchParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const isOAuthPath = typeof window !== "undefined" && (window.location.pathname === "/oauth/consent" || searchParams.has("authorization_id"));
  const authorizationId = searchParams.get("authorization_id") || undefined;

  useEffect(() => {
    async function initAuth() {
      try {
        const { data } = await supabase.auth.getSession();
        setSession(data?.session ?? null);
      } catch {
        setSession(null);
      } finally {
        setIsInitializing(false);
      }
    }

    void initAuth();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (!newSession) {
        setAccount(null);
        setIsUnclaimed(false);
        setAccountFetchError("");
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [supabase]);

  const loadAccountData = useCallback(async () => {
    if (!session) {
      setAccount(null);
      setIsUnclaimed(false);
      setAccountFetchError("");
      return;
    }
    setIsFetchingAccount(true);
    try {
      const res = await fetchHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
      setAccount(res.account);
      setIsUnclaimed(false);
      setAccountFetchError("");
      setErrorMessage("");
    } catch (err: unknown) {
      setAccount(null);
      const status = (err instanceof ArcApiError) ? err.status : (err as { status?: number })?.status;
      if (status === 404) {
        setIsUnclaimed(true);
        setAccountFetchError("");
      } else if (status === 401 || status === 403) {
        setIsUnclaimed(false);
        setAccountFetchError("Session expired or unauthorized. Please sign in again.");
        void supabase.auth.signOut();
      } else {
        setIsUnclaimed(false);
        const msg = err instanceof Error ? err.message : "Failed to load account information.";
        setAccountFetchError(msg);
      }
    } finally {
      setIsFetchingAccount(false);
    }
  }, [session, activeConfig.apiOrigin, customFetch, supabase]);

  useEffect(() => {
    void loadAccountData();
  }, [loadAccountData]);

  const handleSignIn = async (email: string, pass: string) => {
    setIsSubmitting(true);
    setErrorMessage("");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) {
      setIsSubmitting(false);
      throw new Error(error.message);
    }
    setSession(data.session);
    setIsSubmitting(false);
  };

  const handleSignUp = async (email: string, pass: string) => {
    setIsSubmitting(true);
    setErrorMessage("");
    const { data, error } = await supabase.auth.signUp({ email, password: pass });
    if (error) {
      setIsSubmitting(false);
      throw new Error(error.message);
    }
    if (data.session) {
      setSession(data.session);
    } else {
      const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password: pass });
      if (signInErr) {
        setIsSubmitting(false);
        throw new Error(signInErr.message);
      }
      setSession(signInData.session);
    }
    setIsSubmitting(false);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setAccount(null);
    setIsUnclaimed(false);
    setAccountFetchError("");
  };

  const handleClaimAccount = async () => {
    if (!session) return;
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      const res = await claimHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
      setAccount(res.account);
      setIsUnclaimed(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to claim hosted account.";
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleProvisionWallet = async () => {
    if (!session) return;
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      const res = await provisionWallet(activeConfig.apiOrigin, session.access_token, customFetch);
      setAccount((prev) =>
        prev
          ? {
              ...prev,
              wallet: {
                status: res.wallet.status,
                address: res.wallet.address,
              },
            }
          : null,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to provision wallet.";
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePauseAccount = async () => {
    if (!session) return;
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      const res = await pauseHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
      setAccount(res.account);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to pause account.";
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResumeAccount = async () => {
    if (!session) return;
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      const res = await resumeHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
      setAccount(res.account);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to resume account.";
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWithdraw = async (destination: string, amount: string, idempotencyKey: string) => {
    if (!session) return;
    setIsSubmitting(true);
    setErrorMessage("");
    setWithdrawalResult(null);
    try {
      const res = await withdrawHostedAccount(
        activeConfig.apiOrigin,
        session.access_token,
        {
          destination,
          amount,
          idempotencyKey,
          confirmed: true,
        },
        customFetch,
      );
      setWithdrawalResult(res.withdrawal);
      void loadAccountData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to execute withdrawal.";
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Full page spinner ONLY during initial auth boot or initial account fetch when no state exists yet
  if (isInitializing || (isFetchingAccount && !account && !isUnclaimed && !accountFetchError)) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <div className="spinner" id="app-loading-spinner" />
      </div>
    );
  }

  // Render AuthForm if unauthenticated
  if (!session) {
    return (
      <>
        <Header userEmail={undefined} onSignOut={handleSignOut} />
        <main>
          {isOAuthPath && (
            <div className="container" style={{ marginTop: "1rem" }} id="oauth-signin-banner">
              <div className="alert alert-info">
                <span>Please sign in to authorize application request.</span>
              </div>
            </div>
          )}
          <AuthForm
            onSignIn={handleSignIn}
            onSignUp={handleSignUp}
            errorMessage={errorMessage}
            isLoading={isSubmitting}
          />
        </main>
      </>
    );
  }

  // Render OAuth 2.1 Consent View ONLY if authenticated and on OAuth route
  if (isOAuthPath) {
    return (
      <>
        <Header userEmail={session.user.email} onSignOut={handleSignOut} />
        <main className="container">
          <OAuthConsent supabaseClient={supabase} authorizationId={authorizationId} />
        </main>
      </>
    );
  }

  // Render Server Error / Retry view if loading account failed with 500 or network error
  if (accountFetchError) {
    return (
      <>
        <Header userEmail={session.user.email} onSignOut={handleSignOut} />
        <main className="container">
          <div className="card" id="account-error-card">
            <h2 className="card-title">Account Load Error</h2>
            <div className="alert alert-danger" style={{ marginTop: "1rem" }} id="account-fetch-error-alert">
              <span>{accountFetchError}</span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void loadAccountData()}
              disabled={isFetchingAccount}
              id="retry-account-fetch-btn"
              style={{ marginTop: "1rem" }}
            >
              {isFetchingAccount ? "Retrying..." : "Retry Loading Account"}
            </button>
          </div>
        </main>
      </>
    );
  }

  // Render Autonomy Consent Modal ONLY if verified 404 (unclaimed)
  if (isUnclaimed || !account) {
    return (
      <>
        <Header userEmail={session.user.email} onSignOut={handleSignOut} />
        <main className="container">
          <ConsentModal
            userEmail={session.user.email}
            onClaim={handleClaimAccount}
            onSignOut={handleSignOut}
            isLoading={isSubmitting}
            errorMessage={errorMessage}
          />
        </main>
      </>
    );
  }

  // Render Main Dashboard
  return (
    <>
      <Header userEmail={session.user.email} onSignOut={handleSignOut} />
      <main>
        <Dashboard
          account={account}
          onProvisionWallet={handleProvisionWallet}
          onPauseAccount={handlePauseAccount}
          onResumeAccount={handleResumeAccount}
          onWithdraw={handleWithdraw}
          isLoading={isSubmitting}
          errorMessage={errorMessage}
          withdrawalResult={withdrawalResult}
        />
      </main>
    </>
  );
};
