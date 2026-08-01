import React, { useEffect, useState, useCallback, useRef } from "react";
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
  fetchWithdrawalStatus,
  ArcApiError,
  fetchHostedClients,
  setHostedClientPayment,
  type SafeAccountInfo,
} from "./api.ts";
import { pollWithdrawalUntilTerminal } from "./withdrawal-polling.ts";
import { Header } from "./components/Header.tsx";
import { AuthForm } from "./components/AuthForm.tsx";
import { ConsentModal } from "./components/ConsentModal.tsx";
import { Dashboard } from "./components/Dashboard.tsx";
import { OAuthConsent } from "./components/OAuthConsent.tsx";

export const ARC_WALLET_LOGIN_STATEMENT =
  "Sign in to AgentPay Arc to verify your external wallet identity only. This does not approve payments or grant access to your hosted Circle wallet.";

export async function signInWithArcWallet(client: Pick<SupabaseClient, "auth">): Promise<Session> {
  const { data, error } = await client.auth.signInWithWeb3({
    chain: "ethereum",
    statement: ARC_WALLET_LOGIN_STATEMENT,
  });
  if (error || !data.session) {
    throw new Error("Wallet sign in failed. Connect your wallet and try again.");
  }
  return data.session;
}

export function sanitizeErrorMessage(msg: string): string {
  const safeMessages = new Set([
    "Network error. Unable to reach Arc server.",
    "Invalid response from Arc server.",
    "The Arc request could not be completed.",
    "The Arc server could not complete the request. Please try again.",
  ]);
  return safeMessages.has(msg)
    ? msg
    : "An unexpected error occurred. Please try again.";
}

export function getSessionIdentity(session: Session | null): string | null {
  return session?.user.id ?? null;
}

export interface AppProps {
  readonly config?: PublicConfig;
  readonly supabaseClient?: SupabaseClient;
  readonly customFetch?: typeof fetch;
  readonly initialSession?: Session | null;
  readonly initialAccount?: SafeAccountInfo | null;
  readonly initialIsUnclaimed?: boolean;
  readonly initialAccountFetchError?: string;
  readonly initialIsInitializing?: boolean;
  readonly initialIsOAuthPath?: boolean;
  readonly initialAuthorizationId?: string;
  readonly initialIsFetchingAccount?: boolean;
}

export const App: React.FC<AppProps> = ({
  config,
  supabaseClient,
  customFetch,
  initialSession = null,
  initialAccount = null,
  initialIsUnclaimed = false,
  initialAccountFetchError = "",
  initialIsInitializing = true,
  initialIsOAuthPath,
  initialAuthorizationId,
  initialIsFetchingAccount = false,
}) => {
  const activeConfig = config ?? getPublicConfig();
  const supabase = supabaseClient ?? getSupabaseClient(activeConfig, customFetch);

  const [session, setSession] = useState<Session | null>(initialSession);
  const [account, setAccount] = useState<SafeAccountInfo | null>(initialAccount);
  const [isUnclaimed, setIsUnclaimed] = useState(initialIsUnclaimed);
  const [accountFetchError, setAccountFetchError] = useState(initialAccountFetchError);
  const [isInitializing, setIsInitializing] = useState(initialIsInitializing);
  const [isFetchingAccount, setIsFetchingAccount] = useState(initialIsFetchingAccount);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [withdrawalResult, setWithdrawalResult] = useState<{
    status: string;
    transactionHash?: string;
    reconciliationRequired: boolean;
  } | null>(null);
  const [clients, setClients] = useState<
    readonly {
      oauthClientId: string;
      canRead: boolean;
      canSendPayments: boolean;
      revoked: boolean;
    }[]
  >([]);
  const withdrawalPollRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<Session | null>(initialSession);
  const sessionEpochRef = useRef(0);

  const refreshClients = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    try {
      const result = await fetchHostedClients(activeConfig.apiOrigin, token, customFetch);
      setClients(result.clients);
    } catch {
      // A failed listing must not blank the panel: showing an empty list would
      // tell the owner nothing is delegated, which is a different claim from
      // "could not load".
    }
  }, [activeConfig.apiOrigin, customFetch, supabase]);

  const handleSetClientPayment = useCallback(
    async (oauthClientId: string, allowPayment: boolean) => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      await setHostedClientPayment(
        activeConfig.apiOrigin,
        token,
        { oauthClientId, allowPayment },
        customFetch,
      );
      await refreshClients();
    },
    [activeConfig.apiOrigin, customFetch, refreshClients, supabase],
  );

  const replaceSession = useCallback((nextSession: Session | null) => {
    if (getSessionIdentity(sessionRef.current) !== getSessionIdentity(nextSession)) {
      sessionEpochRef.current += 1;
      withdrawalPollRef.current?.abort();
      withdrawalPollRef.current = null;
      setAccount(null);
      setIsUnclaimed(false);
      setAccountFetchError("");
      setErrorMessage("");
      setWithdrawalResult(null);
      setIsSubmitting(false);
    }
    sessionRef.current = nextSession;
    setSession(nextSession);
  }, []);

  useEffect(() => () => {
    withdrawalPollRef.current?.abort();
  }, []);

  const searchParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const isOAuthPath = initialIsOAuthPath ?? (
    typeof window !== "undefined" && window.location.pathname === "/oauth/consent"
  );
  const authorizationId = initialAuthorizationId ?? (searchParams.get("authorization_id") || undefined);

  useEffect(() => {
    async function initAuth() {
      try {
        const { data } = await supabase.auth.getSession();
        replaceSession(data?.session ?? null);
      } catch {
        replaceSession(null);
      } finally {
        setIsInitializing(false);
      }
    }

    void initAuth();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      replaceSession(newSession);
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [supabase, replaceSession]);

  const loadAccountData = useCallback(async () => {
    if (!session) {
      setAccount(null);
      setIsUnclaimed(false);
      setAccountFetchError("");
      return;
    }
    const requestEpoch = sessionEpochRef.current;
    const requestIdentity = getSessionIdentity(session);
    const requestAccessToken = session.access_token;
    const isCurrentSession = () =>
      requestEpoch === sessionEpochRef.current
      && requestIdentity === getSessionIdentity(sessionRef.current);
    const isCurrentCredential = () =>
      isCurrentSession()
      && requestAccessToken === sessionRef.current?.access_token;
    setIsFetchingAccount(true);
    try {
      const res = await fetchHostedAccount(activeConfig.apiOrigin, session.access_token, customFetch);
      if (!isCurrentSession()) return;
      setAccount(res.account);
      setIsUnclaimed(false);
      setAccountFetchError("");
      setErrorMessage("");
    } catch (err: unknown) {
      if (!isCurrentCredential()) return;
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
        setAccountFetchError(sanitizeErrorMessage(msg));
      }
    } finally {
      if (isCurrentCredential()) {
        setIsFetchingAccount(false);
      }
    }
  }, [session, activeConfig.apiOrigin, customFetch, supabase]);

  useEffect(() => {
    void loadAccountData();
    // Delegated clients are part of the account picture, not a separate screen:
    // an owner deciding whether to trust an agent should see both together.
    void refreshClients();
  }, [loadAccountData, refreshClients]);

  const handleSignIn = async () => {
    setIsSubmitting(true);
    setErrorMessage("");
    try {
      const walletSession = await signInWithArcWallet(supabase);
      replaceSession(walletSession);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    replaceSession(null);
    await supabase.auth.signOut();
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
      setErrorMessage(sanitizeErrorMessage(msg));
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
      setErrorMessage(sanitizeErrorMessage(msg));
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
      setErrorMessage(sanitizeErrorMessage(msg));
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
      setErrorMessage(sanitizeErrorMessage(msg));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWithdraw = async (destination: string, amount: string, idempotencyKey: string) => {
    if (!session) return;
    const requestEpoch = sessionEpochRef.current;
    const requestIdentity = getSessionIdentity(session);
    const isCurrentSession = () =>
      requestEpoch === sessionEpochRef.current
      && requestIdentity === getSessionIdentity(sessionRef.current);
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
      const submitted = {
        status: res.withdrawal.status,
        transactionId: res.withdrawal.transactionId,
        transactionHash: res.withdrawal.transactionHash,
        reconciliationRequired: res.withdrawal.reconciliationRequired,
      };
      if (!isCurrentSession()) return;
      setWithdrawalResult(submitted);
      if (
        submitted.transactionId
        && submitted.status !== "COMPLETED"
        && submitted.status !== "FAILED"
      ) {
        withdrawalPollRef.current?.abort();
        const controller = new AbortController();
        withdrawalPollRef.current = controller;
        try {
          const terminal = await pollWithdrawalUntilTerminal({
            initial: submitted,
            signal: controller.signal,
            fetchStatus: async () => {
              if (!isCurrentSession()) {
                throw new DOMException("Withdrawal polling aborted", "AbortError");
              }
              const status = await fetchWithdrawalStatus(
                activeConfig.apiOrigin,
                sessionRef.current?.access_token ?? session.access_token,
                {
                  idempotencyKey,
                  transactionId: submitted.transactionId!,
                },
                customFetch,
              );
              if (!isCurrentSession()) {
                throw new DOMException("Withdrawal polling aborted", "AbortError");
              }
              return status.withdrawal;
            },
          });
          if (isCurrentSession()) {
            setWithdrawalResult(terminal);
          }
        } catch (pollError: unknown) {
          if (
            isCurrentSession()
            && !(pollError instanceof DOMException && pollError.name === "AbortError")
          ) {
            setWithdrawalResult({
              ...submitted,
              reconciliationRequired: true,
            });
          }
        } finally {
          if (withdrawalPollRef.current === controller) {
            withdrawalPollRef.current = null;
          }
        }
      }
      if (isCurrentSession()) {
        await loadAccountData();
      }
    } catch (err: unknown) {
      if (isCurrentSession()) {
        const msg = err instanceof Error ? err.message : "Failed to execute withdrawal.";
        setErrorMessage(sanitizeErrorMessage(msg));
      }
    } finally {
      if (isCurrentSession()) {
        setIsSubmitting(false);
      }
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
        <Header onSignOut={handleSignOut} />
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
        <Header isAuthenticated onSignOut={handleSignOut} />
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
        <Header isAuthenticated onSignOut={handleSignOut} />
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
        <Header isAuthenticated onSignOut={handleSignOut} />
        <main className="container">
          <ConsentModal
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
      <Header isAuthenticated onSignOut={handleSignOut} />
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
          clients={clients}
          onSetClientPayment={handleSetClientPayment}
        />
      </main>
    </>
  );
};
