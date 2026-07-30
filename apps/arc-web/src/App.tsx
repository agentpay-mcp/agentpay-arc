import React, { useEffect, useState } from "react";
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
  const [isInitializing, setIsInitializing] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [withdrawalResult, setWithdrawalResult] = useState<{
    status: string;
    transactionHash?: string;
    reconciliationRequired: boolean;
  } | null>(null);

  // Check current URL parameters for OAuth consent route
  const searchParams = new URLSearchParams(window.location.search);
  const isOAuthPath = window.location.pathname === "/oauth/consent" || searchParams.has("authorization_id");
  const authorizationId = searchParams.get("authorization_id") || undefined;

  useEffect(() => {
    async function initAuth() {
      try {
        const { data } = await supabase.auth.getSession();
        setSession(data?.session ?? null);
      } catch (err: unknown) {
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
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [supabase]);

  // Load hosted account data whenever user is authenticated
  useEffect(() => {
    async function loadAccountData() {
      if (!session) {
        setAccount(null);
        return;
      }
      setIsLoading(true);
      try {
        const res = await fetchHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
        setAccount(res.account);
        setErrorMessage("");
      } catch (err: unknown) {
        // If 404, account has not been claimed yet (will prompt consent)
        setAccount(null);
      } finally {
        setIsLoading(false);
      }
    }

    void loadAccountData();
  }, [session, activeConfig.apiOrigin, customFetch]);

  const handleSignIn = async (email: string, pass: string) => {
    setIsLoading(true);
    setErrorMessage("");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) {
      setIsLoading(false);
      throw new Error(error.message);
    }
    setSession(data.session);
    setIsLoading(false);
  };

  const handleSignUp = async (email: string, pass: string) => {
    setIsLoading(true);
    setErrorMessage("");
    const { data, error } = await supabase.auth.signUp({ email, password: pass });
    if (error) {
      setIsLoading(false);
      throw new Error(error.message);
    }
    setSession(data.session);
    setIsLoading(false);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setAccount(null);
  };

  const handleClaimAccount = async () => {
    if (!session) return;
    setIsLoading(true);
    setErrorMessage("");
    try {
      const res = await claimHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
      setAccount(res.account);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to claim hosted account.";
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleProvisionWallet = async () => {
    if (!session) return;
    setIsLoading(true);
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
      setIsLoading(false);
    }
  };

  const handlePauseAccount = async () => {
    if (!session) return;
    setIsLoading(true);
    setErrorMessage("");
    try {
      const res = await pauseHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
      setAccount(res.account);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to pause account.";
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResumeAccount = async () => {
    if (!session) return;
    setIsLoading(true);
    setErrorMessage("");
    try {
      const res = await resumeHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
      setAccount(res.account);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to resume account.";
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleWithdraw = async (destination: string, amount: string, idempotencyKey: string) => {
    if (!session) return;
    setIsLoading(true);
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Withdrawal failed.";
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  };

  // Render OAuth 2.1 Consent View if on /oauth/consent path
  if (isOAuthPath) {
    return (
      <>
        <Header userEmail={session?.user?.email} onSignOut={session ? handleSignOut : undefined} />
        <main className="container">
          <OAuthConsent supabaseClient={supabase} authorizationId={authorizationId} />
        </main>
      </>
    );
  }

  if (isInitializing) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <p style={{ color: "var(--text-muted)", fontSize: "1.1rem" }}>Loading AgentPay Arc...</p>
      </div>
    );
  }

  // Render Auth View if not logged in
  if (!session) {
    return (
      <>
        <Header />
        <main className="container">
          <AuthForm
            onSignIn={handleSignIn}
            onSignUp={handleSignUp}
            errorMessage={errorMessage}
            isLoading={isLoading}
          />
        </main>
      </>
    );
  }

  // Render Autonomy Consent Modal if account is not claimed yet
  if (!account) {
    return (
      <>
        <Header userEmail={session.user.email} onSignOut={handleSignOut} />
        <main className="container">
          <ConsentModal
            onClaim={handleClaimAccount}
            isLoading={isLoading}
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
          isLoading={isLoading}
          errorMessage={errorMessage}
          withdrawalResult={withdrawalResult}
        />
      </main>
    </>
  );
};
