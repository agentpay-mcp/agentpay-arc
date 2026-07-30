import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { Header } from "./components/Header.tsx";
import { AuthForm } from "./components/AuthForm.tsx";
import { ConsentModal } from "./components/ConsentModal.tsx";
import { Dashboard } from "./components/Dashboard.tsx";
import { OAuthConsent } from "./components/OAuthConsent.tsx";
import { App, sanitizeErrorMessage } from "./App.tsx";
import { ARC_AUTONOMY_CONSENT_VERSION } from "@agentpay-ai/shared-arc/arc-hosted-auth";
import type { Session } from "@supabase/supabase-js";

test("sanitizeErrorMessage turns raw database/SQL/internal errors into clean user messages", () => {
  assert.equal(
    sanitizeErrorMessage('relation "public.tenants" does not exist'),
    "An unexpected error occurred. Please try again.",
  );
  assert.equal(
    sanitizeErrorMessage("syntax error at or near SELECT"),
    "An unexpected error occurred. Please try again.",
  );
  assert.equal(
    sanitizeErrorMessage("column name does not exist in postgres"),
    "An unexpected error occurred. Please try again.",
  );
  assert.equal(
    sanitizeErrorMessage("Invalid password provided."),
    "An unexpected error occurred. Please try again.",
  );
  assert.equal(
    sanitizeErrorMessage(""),
    "An unexpected error occurred. Please try again.",
  );
  assert.equal(
    sanitizeErrorMessage("Network error. Unable to reach Arc server."),
    "Network error. Unable to reach Arc server.",
  );
});

test("Header component renders brand logo, network badge, user email, and sign-out button", () => {
  const html = renderToString(<Header userEmail="user@example.com" onSignOut={async () => {}} />);
  assert.ok(html.includes("AgentPay Arc"));
  assert.ok(html.includes("ARC-TESTNET"));
  assert.ok(html.includes("user@example.com"));
  assert.ok(html.includes("Sign Out"));

  const noUserHtml = renderToString(<Header />);
  assert.ok(!noUserHtml.includes("Sign Out"));
});

test("AuthForm renders sign in and sign up modes, error messages, and loading states", () => {
  const signInHtml = renderToString(
    <AuthForm
      onSignIn={async () => {}}
      onSignUp={async () => {}}
      errorMessage="Invalid email or password"
      isLoading={false}
      defaultMode="signin"
    />,
  );
  assert.ok(signInHtml.includes("Sign In to AgentPay Arc"));
  assert.ok(signInHtml.includes("Invalid email or password"));
  assert.ok(signInHtml.includes("Sign Up"));

  const signUpHtml = renderToString(
    <AuthForm
      onSignIn={async () => {}}
      onSignUp={async () => {}}
      isLoading={false}
      defaultMode="signup"
    />,
  );
  assert.ok(signUpHtml.includes("Create Arc Account"));
  assert.ok(signUpHtml.includes("Create Account &amp; Continue"));
  assert.ok(signUpHtml.includes("Sign In"));

  const loadingSignInHtml = renderToString(
    <AuthForm
      onSignIn={async () => {}}
      onSignUp={async () => {}}
      isLoading={true}
      defaultMode="signin"
    />,
  );
  assert.ok(loadingSignInHtml.includes("Processing..."));

  const loadingSignUpHtml = renderToString(
    <AuthForm
      onSignIn={async () => {}}
      onSignUp={async () => {}}
      isLoading={true}
      defaultMode="signup"
    />,
  );
  assert.ok(loadingSignUpHtml.includes("Processing..."));
});

test("ConsentModal renders autonomy consent statement, custom email, errors, and sign out button states", () => {
  const html = renderToString(
    <ConsentModal
      userEmail="agent@example.com"
      onClaim={async () => {}}
      onSignOut={async () => {}}
      isLoading={false}
      errorMessage="Consent error"
    />,
  );
  assert.ok(html.includes("Autonomy Consent Policy"));
  assert.ok(html.includes("agent@example.com"));
  assert.ok(html.includes("Consent error"));
  assert.ok(html.includes("Claim Hosted Account"));
  assert.ok(html.includes("Sign Out"));

  const fallbackEmailHtml = renderToString(
    <ConsentModal
      onClaim={async () => {}}
      isLoading={false}
    />,
  );
  assert.ok(fallbackEmailHtml.includes("agent@example.com"));
  assert.ok(!fallbackEmailHtml.includes("id=\"consent-sign-out-btn\""));

  const loadingHtml = renderToString(
    <ConsentModal
      userEmail="agent@example.com"
      onClaim={async () => {}}
      onSignOut={async () => {}}
      isLoading={true}
    />,
  );
  assert.ok(loadingHtml.includes("Claiming..."));
});

test("Dashboard renders pending/provisioning/failed/closed wallet statuses and action buttons", () => {
  const pendingHtml = renderToString(
    <Dashboard
      account={{
        status: "ACTIVE",
        consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        wallet: { status: "PENDING" },
      }}
      onProvisionWallet={async () => {}}
      onPauseAccount={async () => {}}
      onResumeAccount={async () => {}}
      onWithdraw={async () => {}}
    />,
  );
  assert.ok(pendingHtml.includes("Provision SCA Wallet"));
  assert.ok(pendingHtml.includes("PENDING"));
  assert.ok(pendingHtml.includes("Balance projection unavailable"));
  assert.ok(pendingHtml.includes("Activity projection unavailable."));

  const provisioningHtml = renderToString(
    <Dashboard
      account={{
        status: "ACTIVE",
        consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        wallet: { status: "PROVISIONING" },
      }}
      onProvisionWallet={async () => {}}
      onPauseAccount={async () => {}}
      onResumeAccount={async () => {}}
      onWithdraw={async () => {}}
      isLoading={true}
    />,
  );
  assert.ok(provisioningHtml.includes("Provisioning SCA Wallet..."));

  const failedHtml = renderToString(
    <Dashboard
      account={{
        status: "ACTIVE",
        consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        wallet: { status: "FAILED" },
      }}
      onProvisionWallet={async () => {}}
      onPauseAccount={async () => {}}
      onResumeAccount={async () => {}}
      onWithdraw={async () => {}}
    />,
  );
  assert.ok(failedHtml.includes("FAILED"));
});

test("Dashboard renders account details, live wallet status, balance, paused state, and activity items", () => {
  const html = renderToString(
    <Dashboard
      account={{
        status: "ACTIVE",
        consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        wallet: { status: "LIVE", address: "0x1111111111111111111111111111111111111111" },
        balanceUsdc: "250.50",
        activity: [],
      }}
      onProvisionWallet={async () => {}}
      onPauseAccount={async () => {}}
      onResumeAccount={async () => {}}
      onWithdraw={async () => {}}
      errorMessage="Dashboard warning message"
    />,
  );
  assert.ok(html.includes("0x1111111111111111111111111111111111111111"));
  assert.ok(html.includes("250.50"));
  assert.ok(html.includes("No recent transactions recorded for this account."));
  assert.ok(html.includes("Pause Account"));
  assert.ok(html.includes("Dashboard warning message"));

  const pausedHtml = renderToString(
    <Dashboard
      account={{
        status: "PAUSED",
        consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        wallet: { status: "LIVE", address: "0x1111111111111111111111111111111111111111" },
        balanceUsdc: "10.00",
        activity: [
          {
            id: "act-1",
            type: "Deposit",
            amount: "10.00",
            status: "COMPLETED",
            timestamp: "2026-07-30T10:00:00Z",
          },
        ],
      }}
      onProvisionWallet={async () => {}}
      onPauseAccount={async () => {}}
      onResumeAccount={async () => {}}
      onWithdraw={async () => {}}
      withdrawalResult={{ status: "COMPLETED", transactionHash: "0xabc", reconciliationRequired: true }}
    />,
  );
  assert.ok(pausedHtml.includes("Resume Account"));
  assert.ok(pausedHtml.includes("Deposit"));
  assert.ok(pausedHtml.includes("0xabc"));
  assert.ok(pausedHtml.includes("Status is pending reconciliation with Arc network."));

  const completedHtml = renderToString(
    <Dashboard
      account={{
        status: "ACTIVE",
        consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        wallet: { status: "LIVE", address: "0x1111111111111111111111111111111111111111" },
      }}
      onProvisionWallet={async () => {}}
      onPauseAccount={async () => {}}
      onResumeAccount={async () => {}}
      onWithdraw={async () => {}}
      withdrawalResult={{ status: "COMPLETED", reconciliationRequired: false }}
    />,
  );
  assert.ok(completedHtml.includes("Withdrawal Outcome:"));
  assert.ok(completedHtml.includes("COMPLETED"));
});

test("OAuthConsent renders loading, error card, missing authorizationId, and loaded states", () => {
  const mockClient = {} as unknown as Parameters<typeof OAuthConsent>[0]["supabaseClient"];

  const loadingHtml = renderToString(<OAuthConsent supabaseClient={mockClient} />);
  assert.ok(loadingHtml.includes("Loading Authorization Request..."));

  const errorHtml = renderToString(
    <OAuthConsent
      supabaseClient={mockClient}
      initialLoading={false}
      initialErrorMsg="Missing required authorization_id parameter."
    />,
  );
  assert.ok(errorHtml.includes("OAuth Authorization Error"));
  assert.ok(errorHtml.includes("Missing required authorization_id parameter."));

  const invalidUuidHtml = renderToString(
    <OAuthConsent
      supabaseClient={mockClient}
      authorizationId="invalid-uuid"
      initialLoading={false}
      initialErrorMsg="Invalid authorization_id format. Must be a valid UUID."
    />,
  );
  assert.ok(invalidUuidHtml.includes("Invalid authorization_id format. Must be a valid UUID."));

  const nullDetailsHtml = renderToString(
    <OAuthConsent
      supabaseClient={mockClient}
      initialLoading={false}
      initialErrorMsg=""
      initialDetails={null}
    />,
  );
  assert.ok(nullDetailsHtml.includes("Invalid or expired authorization request."));

  const loadedHtml = renderToString(
    <OAuthConsent
      supabaseClient={mockClient}
      authorizationId="9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
      initialLoading={false}
      initialDetails={{
        clientName: "Agent Client App",
        redirectUri: "https://client.example.com/oauth/callback",
        scopes: ["openid", "offline_access"],
      }}
    />,
  );
  assert.ok(loadedHtml.includes("Authorize Application Access"));
  assert.ok(loadedHtml.includes("Agent Client App"));
  assert.ok(loadedHtml.includes("https://client.example.com/oauth/callback"));
  assert.ok(loadedHtml.includes("openid"));
  assert.ok(loadedHtml.includes("offline_access"));
});

test("App component renders loading spinner, unauthenticated form, OAuth banner, consent modal, error card, and dashboard", () => {
  const testConfig = {
    publicOrigin: "https://arc.agentpay.site",
    apiOrigin: "https://mcp.arc.agentpay.site",
    supabaseUrl: "https://example.supabase.co",
    supabasePublishableKey: "public-key-123",
  };

  const fakeSupabase = {
    auth: {
      async getSession() {
        return { data: { session: null } };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  } as unknown as Parameters<typeof App>[0]["supabaseClient"];

  const loadingHtml = renderToString(<App config={testConfig} supabaseClient={fakeSupabase} />);
  assert.ok(loadingHtml.includes('id="app-loading-spinner"'));

  const fetchingSpinnerHtml = renderToString(
    <App
      config={testConfig}
      supabaseClient={fakeSupabase}
      initialIsInitializing={false}
      initialIsFetchingAccount={true}
    />,
  );
  assert.ok(fetchingSpinnerHtml.includes('id="app-loading-spinner"'));

  const unauthHtml = renderToString(
    <App
      config={testConfig}
      supabaseClient={fakeSupabase}
      initialIsInitializing={false}
      initialSession={null}
    />,
  );
  assert.ok(unauthHtml.includes("Sign In to AgentPay Arc"));

  const unauthOAuthHtml = renderToString(
    <App
      config={testConfig}
      supabaseClient={fakeSupabase}
      initialIsInitializing={false}
      initialSession={null}
      initialIsOAuthPath={true}
    />,
  );
  assert.ok(unauthOAuthHtml.includes("Please sign in to authorize application request."));

  const dummySession = {
    access_token: "token123",
    user: { id: "user1", email: "agent@example.com" },
  } as unknown as Session;

  const authOAuthHtml = renderToString(
    <App
      config={testConfig}
      supabaseClient={fakeSupabase}
      initialIsInitializing={false}
      initialSession={dummySession}
      initialIsOAuthPath={true}
      initialAuthorizationId="9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
    />,
  );
  assert.ok(authOAuthHtml.includes("Loading Authorization Request..."));

  const unclaimedHtml = renderToString(
    <App
      config={testConfig}
      supabaseClient={fakeSupabase}
      initialIsInitializing={false}
      initialSession={dummySession}
      initialIsUnclaimed={true}
    />,
  );
  assert.ok(unclaimedHtml.includes("Autonomous Agent Wallet Consent"));

  const nullAccountHtml = renderToString(
    <App
      config={testConfig}
      supabaseClient={fakeSupabase}
      initialIsInitializing={false}
      initialSession={dummySession}
      initialAccount={null}
      initialIsUnclaimed={false}
    />,
  );
  assert.ok(nullAccountHtml.includes("Autonomous Agent Wallet Consent"));

  const errorCardHtml = renderToString(
    <App
      config={testConfig}
      supabaseClient={fakeSupabase}
      initialIsInitializing={false}
      initialSession={dummySession}
      initialAccountFetchError="Session expired or unauthorized. Please sign in again."
    />,
  );
  assert.ok(errorCardHtml.includes("Account Load Error"));
  assert.ok(errorCardHtml.includes("Session expired or unauthorized. Please sign in again."));

  const dashboardHtml = renderToString(
    <App
      config={testConfig}
      supabaseClient={fakeSupabase}
      initialIsInitializing={false}
      initialSession={dummySession}
      initialAccount={{
        status: "ACTIVE",
        consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        wallet: { status: "LIVE", address: "0x1111111111111111111111111111111111111111" },
        balanceUsdc: "100.00",
        activity: [],
      }}
    />,
  );
  assert.ok(dashboardHtml.includes("Arc Agent Wallet"));
  assert.ok(dashboardHtml.includes("0x1111111111111111111111111111111111111111"));
});
