import { ARC_TESTNET } from "@agentpay-ai/shared-arc";

/**
 * Server-rendered marketplace markup.
 *
 * Everything here is a pure string function: no client script is emitted, so
 * the page cannot connect a wallet, sign, or execute a payment even if a
 * caller wanted it to. Payment execution stays in the user's local AgentPay
 * MCP; the page only produces a prompt they can copy.
 */

const ARC_EXPLORER_TX = `${ARC_TESTNET.explorerUrl}/tx/`;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

/** Every interpolated value passes through this. Metadata is agent-supplied. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface RenderedService {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly url: string;
  readonly price: string;
  readonly token: string;
  readonly sellerAddress: string;
  readonly sellerAgentId?: string;
}

export interface RenderedTrust {
  readonly agentId: string;
  readonly registrationFetched: boolean;
  readonly endpointDomainVerified: boolean;
  readonly feedbackCount: string;
  readonly averageScore: string | null;
  readonly validationResponses: string;
}

export interface RenderedJob {
  readonly jobId: string;
  readonly state: string;
  readonly budget: string;
  readonly expiredAt: string;
}

export interface RenderedActivity {
  readonly id: string;
  readonly kind: string;
  readonly amount: string;
  readonly token: string;
  readonly transactionHash: string | null;
  readonly occurredAt: string;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · AgentPay Arc Marketplace</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 60rem; }
nav a { margin-right: 1rem; }
.card { border: 1px solid currentColor; border-radius: .5rem; padding: 1rem; margin: 1rem 0; }
.meta { display: flex; flex-wrap: wrap; gap: 1rem; font-size: .9rem; }
.prompt { width: 100%; min-height: 5rem; font-family: ui-monospace, monospace; }
:focus-visible { outline: 3px solid; outline-offset: 2px; }
@media (max-width: 40rem) { body { padding: 1rem; } .meta { flex-direction: column; gap: .25rem; } }
</style>
</head>
<body>
<nav aria-label="Marketplace"><a href="/">Services</a><a href="/activity">Activity</a></nav>
<main>
${body}
</main>
</body>
</html>`;
}

function networkLine(price: string, token: string): string {
  return `<p class="meta"><span>Price: <strong>${escapeHtml(price)} ${escapeHtml(token)}</strong></span>
<span>Network: <strong>${escapeHtml(ARC_TESTNET.name)}</strong></span>
<span>Chain ID: ${ARC_TESTNET.chainId}</span></p>`;
}

export function renderCatalogue(
  services: readonly RenderedService[],
  filters: { readonly query?: string; readonly category?: string },
): string {
  const search = `<form role="search" method="get" action="/">
<label for="q">Search services</label>
<input id="q" name="q" type="search" value="${escapeHtml(filters.query ?? "")}">
<label for="category">Category</label>
<input id="category" name="category" type="text" value="${escapeHtml(filters.category ?? "")}">
<button type="submit">Filter</button>
</form>`;

  const list =
    services.length === 0
      ? `<p>No services matched this search. Try a broader term or clear the category filter.</p>`
      : services
          .map(
            (item) => `<article class="card">
<h2><a href="/services/${encodeURIComponent(item.id)}">${escapeHtml(item.name)}</a></h2>
<p>${escapeHtml(item.description)}</p>
<p class="meta"><span>Category: ${escapeHtml(item.category)}</span></p>
${networkLine(item.price, item.token)}
</article>`,
          )
          .join("\n");

  return layout("Services", `<h1>Paid services on Arc</h1>\n${search}\n${list}`);
}

export type Loaded<T> = { readonly status: "ok"; readonly value: T } | { readonly status: "unavailable" };

function trustSection(result: Loaded<RenderedTrust | null>): string {
  if (result.status === "unavailable") {
    return `<section><h3>Seller trust</h3><p>Trust data is unavailable right now. This is not a statement about the seller.</p></section>`;
  }

  const trust = result.value;
  if (!trust) {
    return `<section><h3>Seller trust</h3><p>No ERC-8004 identity found for this seller.</p></section>`;
  }

  // Each line states what was actually observed. "Verified" is never rendered
  // from a self-reported label -- only from a signal we checked.
  const registration = trust.registrationFetched
    ? "Registration metadata fetched and validated"
    : "Registration metadata not verified";
  const domain = trust.endpointDomainVerified
    ? "Endpoint domain control verified"
    : "Endpoint domain control not verified";
  const score = trust.averageScore === null ? "no score yet" : `${escapeHtml(trust.averageScore)} average`;

  return `<section>
<h3>Seller trust</h3>
<p class="meta"><span>ERC-8004 agent ID: <strong>${escapeHtml(trust.agentId)}</strong></span></p>
<ul>
<li>${escapeHtml(registration)}</li>
<li>${escapeHtml(domain)}</li>
<li>Reputation: ${escapeHtml(trust.feedbackCount)} feedback entries, ${score}</li>
<li>Validation responses: ${escapeHtml(trust.validationResponses)}</li>
</ul>
</section>`;
}

function jobsSection(result: Loaded<readonly RenderedJob[]>): string {
  if (result.status === "unavailable") {
    return `<section><h3>Agent jobs</h3><p>Job data is unavailable right now. This is not a statement about the seller.</p></section>`;
  }

  const jobs = result.value;
  if (jobs.length === 0) {
    return `<section><h3>Agent jobs</h3><p>This seller has no ERC-8183 jobs on record.</p></section>`;
  }

  const rows = jobs
    .map(
      (job) => `<li>Job <strong>${escapeHtml(job.jobId)}</strong> —
${escapeHtml(job.state)}, budget ${escapeHtml(job.budget)} USDC</li>`,
    )
    .join("\n");

  return `<section><h3>Agent jobs (ERC-8183)</h3><ul>${rows}</ul></section>`;
}

export function renderServiceDetail(
  service: RenderedService,
  trust: Loaded<RenderedTrust | null>,
  jobs: Loaded<readonly RenderedJob[]>,
): string {
  // A prompt, not an action. There is no form, no submit control, and no
  // script: the user copies this into their own AgentPay MCP session, where
  // the wallet actually lives.
  const prompt = `Use AgentPay to pay for "${service.name}" at ${service.url} — inspect_paid_service first, then pay_paid_service for ${service.price} ${service.token} on Arc Testnet.`;

  return layout(
    service.name,
    `<h1>${escapeHtml(service.name)}</h1>
<p>${escapeHtml(service.description)}</p>
${networkLine(service.price, service.token)}
<p class="meta"><span>Endpoint: ${escapeHtml(service.url)}</span>
<span>Seller: ${escapeHtml(service.sellerAddress)}</span></p>
${trustSection(trust)}
${jobsSection(jobs)}
<section>
<h3>Buy through your own agent</h3>
<p>Copy this into your AgentPay chat. Payment runs locally in your MCP — this page never touches a wallet.</p>
<label for="agent-prompt">AgentPay prompt</label>
<textarea id="agent-prompt" class="prompt" readonly>${escapeHtml(prompt)}</textarea>
</section>`,
  );
}

export function renderActivity(entries: readonly RenderedActivity[]): string {
  if (entries.length === 0) {
    return layout("Activity", `<h1>Activity</h1><p>No activity recorded yet.</p>`);
  }

  const rows = entries
    .map((entry) => {
      // A hash that does not match the canonical shape gets no link at all,
      // rather than a link that would 404 on Arcscan.
      const proof =
        entry.transactionHash && TRANSACTION_HASH_PATTERN.test(entry.transactionHash)
          ? `<a href="${ARC_EXPLORER_TX}${escapeHtml(entry.transactionHash)}" rel="noopener noreferrer" target="_blank">View proof on Arcscan</a>`
          : `<span>Proof pending</span>`;

      return `<li class="card">
<p class="meta"><span>${escapeHtml(entry.kind)}</span>
<span><strong>${escapeHtml(entry.amount)} ${escapeHtml(entry.token)}</strong></span>
<span>${escapeHtml(entry.occurredAt)}</span></p>
<p>${proof}</p>
</li>`;
    })
    .join("\n");

  return layout("Activity", `<h1>Activity</h1><ul>${rows}</ul>`);
}

export function renderError(message: string): string {
  return layout("Unavailable", `<h1>Marketplace unavailable</h1><p>${escapeHtml(message)}</p>`);
}

export function renderUnauthorized(): string {
  return layout(
    "Sign in required",
    `<h1>Sign in required</h1><p>Activity receipts are private to your workspace. Sign in to view them.</p>`,
  );
}

export function renderNotFound(): string {
  return layout("Not found", `<h1>Not found</h1><p>That service is not listed.</p>`);
}
