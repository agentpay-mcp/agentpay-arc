import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { Header } from "./components/Header.tsx";
import { AuthForm } from "./components/AuthForm.tsx";
import { ConsentModal } from "./components/ConsentModal.tsx";
import { Dashboard } from "./components/Dashboard.tsx";
import { OAuthConsent } from "./components/OAuthConsent.tsx";
import { App } from "./App.tsx";
import { ARC_AUTONOMY_CONSENT_VERSION } from "@agentpay-ai/shared-arc";

test("Header component renders brand logo and network badge", () => {
  const html = renderToString(<Header userEmail="user@example.com" />);
  assert.ok(html.includes("AgentPay Arc"));
  assert.ok(html.includes("ARC-TESTNET"));
  assert.ok(html.includes("user@example.com"));
});

test("Header component renders sign-out button when session exists", () => {
  const html = renderToString(<Header userEmail="user@example.com" onSignOut={async () => {}} />);
  assert.ok(html.includes("Sign Out"));
});

test("AuthForm renders sign in and sign up tabs and handles form input", () => {
  const html = renderToString(
    <AuthForm
      onSignIn={async () => {}}
      onSignUp={async () => {}}
      errorMessage="Invalid password"
      isLoading={false}
    />,
  );
  assert.ok(html.includes("Sign In"));
  assert.ok(html.includes("Sign Up"));
  assert.ok(html.includes("Invalid password"));

  const loadingHtml = renderToString(
    <AuthForm
      onSignIn={async () => {}}
      onSignUp={async () => {}}
      isLoading={true}
    />,
  );
  assert.ok(loadingHtml.includes("Processing..."));
});

test("ConsentModal renders autonomy consent statement, email, and sign out button", () => {
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
});

test("Dashboard renders pending wallet status and provision button", () => {
  const html = renderToString(
    <Dashboard
      account={{
        status: "ACTIVE",
        consentVersion: ARC_AUTONOMY_CONSENT_VERSION,
        wallet: { status: "PENDING" },
        balanceUsdc: "0.00",
        activity: [],
      }}
      onProvisionWallet={async () => {}}
      onPauseAccount={async () => {}}
      onResumeAccount={async () => {}}
      onWithdraw={async () => {}}
    />,
  );
  assert.ok(html.includes("Provision SCA Wallet"));
  assert.ok(html.includes("PENDING"));
});

test("Dashboard renders account details, wallet status, balance, and empty activity", () => {
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
    />,
  );
  assert.ok(html.includes("0x1111111111111111111111111111111111111111"));
  assert.ok(html.includes("250.50"));
  assert.ok(html.includes("No recent transactions recorded for this account."));
  assert.ok(html.includes("Pause Account"));
});

test("Dashboard renders withdrawal result and activity items when provided", () => {
  const html = renderToString(
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
      withdrawalResult={{ status: "COMPLETED", transactionHash: "0xabc", reconciliationRequired: false }}
    />,
  );
  assert.ok(html.includes("Resume Account"));
  assert.ok(html.includes("Deposit"));
  assert.ok(html.includes("0xabc"));
});

test("OAuthConsent initial render shows loading state", () => {
  const mockClient = {} as unknown as Parameters<typeof OAuthConsent>[0]["supabaseClient"];
  const html = renderToString(<OAuthConsent supabaseClient={mockClient} />);
  assert.ok(html.includes("Loading Authorization Request..."));
});

test("App component renders initial loading spinner", () => {
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

  const html = renderToString(<App config={testConfig} supabaseClient={fakeSupabase} />);
  assert.ok(html.includes('id="app-loading-spinner"'));
});
