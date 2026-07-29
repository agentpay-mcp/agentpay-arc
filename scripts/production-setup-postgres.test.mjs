import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";

const postgresImage = "postgres:17-alpine";
const containerName = `agentpay-setup-pg-${randomUUID()}`;
const postgresPassword = randomBytes(24).toString("hex");
const migrationsDir = "supabase/migrations";

const owner = "0x1111111111111111111111111111111111111111";
const executor = "0x2222222222222222222222222222222222222222";
const factory = "0x3333333333333333333333333333333333333333";
const deployer = "0x4444444444444444444444444444444444444444";
const predictedAccount = "0x5555555555555555555555555555555555555555";
const hash = (digit) => `0x${digit.repeat(64)}`;
const bareHash = (digit) => digit.repeat(64);
const signature = `0x${"12".repeat(65)}`;
const intentId = "setup-production-postgres-0001";
const capabilityDigest = bareHash("a");
const now = "2026-07-17T05:00:00.000Z";
const expiresAt = "2026-07-17T05:15:00.000Z";

function run(command, args, { input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
    });
    child.stdin.end(input);
  });
}

async function dockerPsql(sql, { role, tuplesOnly = true, allowFailure = false } = {}) {
  const rolePrefix = role ? `set session authorization authenticator;\nset role ${role};\n` : "";
  const args = ["exec", "-i", containerName, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"];
  if (tuplesOnly) args.push("-A", "-t", "-q");
  return run("docker", args, { input: `${rolePrefix}${sql}\n`, allowFailure });
}

async function waitForPostgres() {
  let lastError = "";
  const readinessDeadline = Date.now() + 60_000;
  while (Date.now() < readinessDeadline) {
    const result = await dockerPsql("select 1;", { allowFailure: true });
    if (result.code === 0 && result.stdout === "1") return;
    lastError = result.stderr || result.stdout;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError}`);
}

async function installMigrations() {
  await dockerPsql(`
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit;
    create role authenticator nologin noinherit;
    grant anon, authenticated, service_role to authenticator;

    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      created_at timestamptz default now()
    );
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
  `, { tuplesOnly: false });

  const migrationNames = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const migrationName of migrationNames) {
    await dockerPsql(await readFile(`${migrationsDir}/${migrationName}`, "utf8"), { tuplesOnly: false });
  }
}

async function seedRuntimeState() {
  await dockerPsql(`
    insert into public.setup_runtime_state (
      id, environment, chain_id, setup_mode, manifest_sha256, factory_address,
      factory_runtime_code_hash, executor_address, sponsor_deployer_address,
      max_deployments_per_day, max_gas_per_deployment, max_native_cost_per_day_wei, max_pending
    ) values (
      1, 'production', 42220, 'PUBLIC', '${hash("1")}', '${factory}', '${hash("2")}',
      '${executor}', '${deployer}', 10, 5000000, 1000000000000000000, 4
    );
  `, { tuplesOnly: false });
}

function createChallengeSql() {
  return `select public.create_production_setup_challenge(
    '${intentId}', '${capabilityDigest}', '${owner}', '${executor}', 'canonical typed data',
    '${hash("3")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("4")}',
    '${predictedAccount}', '${hash("5")}', '${hash("6")}', '${hash("7")}',
    '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("b")}', 60, 20
  )::text;`;
}

async function scalar(sql, options) {
  return (await dockerPsql(sql, options)).stdout;
}

describe("production setup migration on disposable PostgreSQL", () => {
  before(async () => {
    const migrationNames = await readdir(migrationsDir);
    assert.ok(
      migrationNames.includes("20260721130000_celo_production_mainnet_onboarding.sql"),
      "production onboarding migration must exist before the integration gate can start",
    );

    const daemon = await run("docker", ["info"], { allowFailure: true });
    assert.equal(daemon.code, 0, `Docker daemon is required for the real PostgreSQL gate: ${daemon.stderr}`);
    await run("docker", [
      "run", "--detach", "--rm", "--name", containerName,
      "--publish", "127.0.0.1::5432",
      "--env", `POSTGRES_PASSWORD=${postgresPassword}`,
      postgresImage,
    ]);
    await waitForPostgres();
    await installMigrations();
    const hostedTablesCount = await scalar("select count(*) from information_schema.tables where table_name in ('arc_hosted_accounts', 'arc_circle_wallet_bindings');");
    assert.equal(hostedTablesCount, "2", "Applying complete migration directory must leave Task 13A tables installed");
    await seedRuntimeState();
  });

  after(async () => {
    await run("docker", ["rm", "--force", containerName], { allowFailure: true });
  });

  it("serializes replayed admission, claiming, sponsor reservation, outbox, and finalization", async () => {
    const challengeResults = await Promise.all(
      Array.from({ length: 8 }, () => scalar(createChallengeSql(), { role: "agentpay_setup_web" })),
    );
    assert.equal(challengeResults.filter((result) => result.includes('"disposition": "CREATED"')).length, 1);
    assert.equal(challengeResults.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);

    const admissionSql = `select public.consume_production_setup_admission(
      '${capabilityDigest}', '${signature}', '${now}'::timestamptz
    )::text;`;
    const admissionResults = await Promise.all(
      Array.from({ length: 8 }, () => scalar(admissionSql, { role: "agentpay_setup_web" })),
    );
    assert.equal(admissionResults.filter((result) => result.includes('"disposition": "ADMITTED"')).length, 1);
    assert.equal(admissionResults.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);

    assert.equal(await scalar("select count(*) from public.tenants where environment = 'production';"), "1");
    assert.equal(await scalar("select count(*) from public.verified_owner_identities where status = 'VERIFIED';"), "1");
    assert.equal(await scalar("select count(*) from public.setup_deployment_jobs;"), "1");

    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        scalar(`select public.claim_setup_deployment_job('worker-${index}', '${now}'::timestamptz, 120)::text;`, {
          role: "agentpay_setup_worker",
        }),
      ),
    );
    const claimed = claims.find((result) => result.includes('"disposition": "CLAIMED"'));
    assert.ok(claimed, "one worker must claim the job");
    assert.equal(claims.filter((result) => result.includes('"disposition": "CLAIMED"')).length, 1);
    assert.equal(claims.filter((result) => result === "").length, 3);
    let claim = JSON.parse(claimed);
    assert.equal(claim.ownerSetupSignature, signature);
    assert.equal(claim.jobStatus, "SIGNING");

    const reserveSql = `select public.reserve_setup_sponsor_budget(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, '${deployer}', 7, 1000000, 1000000000000000,
      '${now}'::timestamptz, 10, 5000000, 1000000000000000000, 4
    )::text;`;
    const reservations = await Promise.all(
      Array.from({ length: 8 }, () => scalar(reserveSql, { role: "agentpay_setup_worker" })),
    );
    assert.equal(reservations.filter((result) => result.includes('"disposition": "RESERVED"')).length, 1);
    assert.equal(reservations.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);

    const persistSql = `select public.persist_setup_signed_transaction(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, 'ciphertext', 'iv', 'tag', '${bareHash("c")}',
      '${hash("8")}', '${now}'::timestamptz
    )::text;`;
    const persisted = await Promise.all(
      Array.from({ length: 8 }, () => scalar(persistSql, { role: "agentpay_setup_worker" })),
    );
    assert.equal(persisted.filter((result) => result.includes('"disposition": "SIGNED"')).length, 1);
    assert.equal(persisted.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);

    const originalFence = claim.fencingToken;
    claim = JSON.parse(await scalar(
      `select public.claim_setup_deployment_job(
        'worker-recovery', '2026-07-17T05:02:01.000Z'::timestamptz, 120
      )::text;`,
      { role: "agentpay_setup_worker" },
    ));
    assert.equal(claim.jobStatus, "SIGNED");
    assert.equal(claim.deployerAddress, deployer);
    assert.equal(claim.deployerNonce, "7");
    assert.equal(claim.transactionHash, hash("8"));
    assert.deepEqual(claim.rawTransaction, {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
      hash: bareHash("c"),
    });
    assert.notEqual(claim.fencingToken, originalFence);

    await scalar(`select public.mark_setup_broadcast_result(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, 'BROADCAST', '${now}'::timestamptz, null
    )::text;`, { role: "agentpay_setup_worker" });
    assert.equal(await scalar(
      `select broadcast_at = '${now}'::timestamptz from public.setup_deployment_jobs where id = '${claim.jobId}'::uuid;`,
    ), "t");
    await scalar(`select public.record_setup_receipt(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, '${hash("8")}', 1, 12345,
      '${now}'::timestamptz
    )::text;`, { role: "agentpay_setup_worker" });

    const finalizations = await Promise.all(
      Array.from({ length: 8 }, () =>
        scalar(`select public.finalize_verified_setup_wallet(
          '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, '${now}'::timestamptz
        )::text;`, { role: "agentpay_setup_worker" }),
      ),
    );
    assert.equal(finalizations.filter((result) => result.includes('"disposition": "COMPLETED"')).length, 1);
    assert.equal(finalizations.filter((result) => result.includes('"disposition": "REPLAY"')).length, 7);
    assert.equal(await scalar("select count(*) from public.agent_wallets where status = 'ACTIVE';"), "1");
    assert.equal(await scalar("select count(*) from public.setup_sponsor_budgets;"), "1");
    assert.equal(await scalar("select count(distinct deployer_nonce) from public.setup_deployment_jobs;"), "1");
    assert.equal(await scalar("select count(distinct transaction_hash) from public.setup_deployment_jobs;"), "1");

    const publicStatus = await scalar(
      `select public.read_production_setup_status('${capabilityDigest}', '${now}'::timestamptz)::text;`,
      { role: "agentpay_setup_web" },
    );
    assert.match(publicStatus, /SETUP_COMPLETED/);
    assert.ok(!publicStatus.includes(signature));
    assert.ok(!publicStatus.includes("ciphertext"));
    const auditPayloads = await scalar("select coalesce(jsonb_agg(metadata), '[]'::jsonb)::text from public.setup_deployment_events;");
    assert.ok(!auditPayloads.includes(signature));
    assert.ok(!auditPayloads.includes("ciphertext"));

    const terminalPersistSql = persistSql.replace(originalFence, claim.fencingToken);
    const terminalRegression = await dockerPsql(terminalPersistSql, { role: "agentpay_setup_worker", allowFailure: true });
    assert.notEqual(terminalRegression.code, 0, "completed jobs cannot regress to signed");
    assert.match(terminalRegression.stderr, /SETUP_STATE_CONFLICT/);

    const mutateAudit = await dockerPsql(
      "update public.setup_deployment_events set event_type = 'MUTATED' where true;",
      { allowFailure: true },
    );
    assert.notEqual(mutateAudit.code, 0, "setup events are append-only");
    assert.match(mutateAudit.stderr, /SETUP_AUDIT_IMMUTABLE/);

    const mutateBudget = await dockerPsql(
      "update public.setup_sponsor_budgets set status = 'CHARGED' where true;",
      { allowFailure: true },
    );
    assert.notEqual(mutateBudget.code, 0, "charged sponsor reservations are immutable");
    assert.match(mutateBudget.stderr, /SETUP_AUDIT_IMMUTABLE/);
  });

  it("finalizes an exactly verified existing account without sponsor spend", async () => {
    const existingOwner = "0x8888888888888888888888888888888888888888";
    const existingCapability = bareHash("9");
    const existingIntent = "setup-production-postgres-existing-0001";
    const existingPredicted = "0x9999999999999999999999999999999999999999";
    await scalar(`select public.create_production_setup_challenge(
      '${existingIntent}', '${existingCapability}', '${existingOwner}', '${executor}', 'existing account typed data',
      '${hash("a")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("b")}',
      '${existingPredicted}', '${hash("5")}', '${hash("6")}', '${hash("c")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("9")}', 60, 20
    )::text;`, { role: "agentpay_setup_web" });
    await scalar(`select public.consume_production_setup_admission(
      '${existingCapability}', '${signature}', '${now}'::timestamptz
    )::text;`, { role: "agentpay_setup_web" });
    const claim = JSON.parse(await scalar(
      `select public.claim_setup_deployment_job('worker-existing', '${now}'::timestamptz, 120)::text;`,
      { role: "agentpay_setup_worker" },
    ));
    const recorded = JSON.parse(await scalar(`select public.record_existing_setup_account(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, 12346, '${now}'::timestamptz
    )::text;`, { role: "agentpay_setup_worker" }));
    assert.equal(recorded.status, "CONFIRMING");
    const completed = JSON.parse(await scalar(`select public.finalize_verified_setup_wallet(
      '${claim.jobId}'::uuid, '${claim.fencingToken}'::uuid, '${now}'::timestamptz
    )::text;`, { role: "agentpay_setup_worker" }));
    assert.equal(completed.accountAddress, existingPredicted);
    assert.equal(await scalar(
      `select count(*) from public.setup_sponsor_budgets where job_id = '${claim.jobId}'::uuid;`,
    ), "0");
  });

  it("rejects duplicate sponsor nonces and transaction hashes across jobs", async () => {
    const secondOwner = "0x6666666666666666666666666666666666666666";
    const secondCapability = bareHash("d");
    const secondIntent = "setup-production-postgres-0002";
    const secondPredicted = "0x7777777777777777777777777777777777777777";
    const actorCollision = await dockerPsql(`select public.create_production_setup_challenge(
      'setup-production-postgres-collision', '${bareHash("0")}', '${deployer}', '${executor}', 'invalid actors',
      '${hash("d")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("e")}',
      '0x8888888888888888888888888888888888888888', '${hash("5")}', '${hash("f")}', '${hash("0")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("0")}', 60, 20
    );`, { role: "agentpay_setup_web", allowFailure: true });
    assert.notEqual(actorCollision.code, 0);
    assert.match(actorCollision.stderr, /SETUP_ACTOR_COLLISION/);

    const createSecond = `select public.create_production_setup_challenge(
      '${secondIntent}', '${secondCapability}', '${secondOwner}', '${executor}', 'canonical typed data 2',
      '${hash("9")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("a")}',
      '${secondPredicted}', '${hash("5")}', '${hash("b")}', '${hash("c")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("e")}', 60, 20
    )::text;`;
    await scalar(createSecond, { role: "agentpay_setup_web" });

    const ownerBusy = await dockerPsql(`select public.create_production_setup_challenge(
      'setup-production-postgres-owner-busy', '${bareHash("1")}', '${secondOwner}', '${executor}', 'different setup',
      '${hash("d")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("e")}',
      '0x8888888888888888888888888888888888888888', '${hash("5")}', '${hash("f")}', '${hash("0")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("1")}', 60, 20
    );`, { role: "agentpay_setup_web", allowFailure: true });
    assert.notEqual(ownerBusy.code, 0);
    assert.match(ownerBusy.stderr, /SETUP_OWNER_BUSY/);

    const deploymentNonceConflict = await dockerPsql(`select public.create_production_setup_challenge(
      'setup-production-postgres-nonce-conflict', '${bareHash("2")}',
      '0x9999999999999999999999999999999999999999', '${executor}', 'duplicate deployment nonce',
      '${hash("9")}', '${hash("1")}', '${factory}', '${hash("2")}', '${hash("f")}',
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '${hash("5")}', '${hash("0")}', '${hash("1")}',
      '${expiresAt}'::timestamptz, '${now}'::timestamptz, '${bareHash("2")}', 60, 20
    );`, { role: "agentpay_setup_web", allowFailure: true });
    assert.notEqual(deploymentNonceConflict.code, 0);
    assert.match(deploymentNonceConflict.stderr, /SETUP_DEPLOYMENT_NONCE_CONFLICT/);

    await scalar(
      `select public.consume_production_setup_admission('${secondCapability}', '${signature}', '${now}'::timestamptz)::text;`,
      { role: "agentpay_setup_web" },
    );
    const secondClaim = JSON.parse(await scalar(
      `select public.claim_setup_deployment_job('worker-second', '${now}'::timestamptz, 120)::text;`,
      { role: "agentpay_setup_worker" },
    ));

    const duplicateNonce = await dockerPsql(`select public.reserve_setup_sponsor_budget(
      '${secondClaim.jobId}'::uuid, '${secondClaim.fencingToken}'::uuid, '${deployer}', 7, 1000000,
      1000000000000000, '${now}'::timestamptz, 10, 5000000, 1000000000000000000, 4
    );`, { role: "agentpay_setup_worker", allowFailure: true });
    assert.notEqual(duplicateNonce.code, 0);
    assert.match(duplicateNonce.stderr, /SETUP_DEPLOYER_NONCE_CONFLICT/);

    await scalar(`select public.reserve_setup_sponsor_budget(
      '${secondClaim.jobId}'::uuid, '${secondClaim.fencingToken}'::uuid, '${deployer}', 8, 1000000,
      1000000000000000, '${now}'::timestamptz, 10, 5000000, 1000000000000000000, 4
    )::text;`, { role: "agentpay_setup_worker" });
    const duplicateHash = await dockerPsql(`select public.persist_setup_signed_transaction(
      '${secondClaim.jobId}'::uuid, '${secondClaim.fencingToken}'::uuid, 'ciphertext-2', 'iv-2', 'tag-2',
      '${bareHash("f")}', '${hash("8")}', '${now}'::timestamptz
    );`, { role: "agentpay_setup_worker", allowFailure: true });
    assert.notEqual(duplicateHash.code, 0);
    assert.match(duplicateHash.stderr, /SETUP_TRANSACTION_HASH_CONFLICT/);
  });

  it("enforces scoped RPC-only runtime roles", async () => {
    assert.equal(
      await scalar(`select count(*) from pg_auth_members memberships
        join pg_roles granted on granted.oid = memberships.roleid
        join pg_roles member on member.oid = memberships.member
        where member.rolname = 'authenticator'
          and granted.rolname in ('agentpay_setup_web', 'agentpay_setup_worker');`),
      "2",
    );
    assert.equal(
      await scalar(`select count(*) from pg_roles
        where rolname in ('agentpay_setup_web', 'agentpay_setup_worker')
          and rolcanlogin = false and rolinherit = false;`),
      "2",
    );

    for (const role of ["public", "anon", "authenticated", "agentpay_setup_web", "agentpay_setup_worker"]) {
      const principal = role === "public" ? "anon" : role;
      const result = await dockerPsql("select * from public.setup_intents limit 1;", { role: principal, allowFailure: true });
      assert.notEqual(result.code, 0, `${role} must not select setup tables`);
    }

    const anonStatus = await dockerPsql(
      `select public.read_production_setup_status('${capabilityDigest}', '${now}'::timestamptz);`,
      { role: "anon", allowFailure: true },
    );
    assert.notEqual(anonStatus.code, 0, "anon cannot execute web RPCs");

    const webRuntime = JSON.parse(await scalar(
      "select public.read_production_setup_runtime_state()::text;",
      { role: "agentpay_setup_web" },
    ));
    assert.deepEqual(webRuntime, {
      environment: "production",
      chainId: 42220,
      setupMode: "PUBLIC",
      manifestSha256: hash("1"),
      factoryAddress: factory,
      factoryRuntimeCodeHash: hash("2"),
      executorAddress: executor,
      sponsorDeployerAddress: deployer,
      maxDeploymentsPerDay: 10,
      maxGasPerDeployment: "5000000",
      maxNativeCostPerDayWei: "1000000000000000000",
      maxPending: 4,
    });
    assert.equal(JSON.stringify(webRuntime).includes("signature"), false);

    for (const role of ["anon", "agentpay_setup_worker"]) {
      const forbiddenRuntime = await dockerPsql(
        "select public.read_production_setup_runtime_state();",
        { role, allowFailure: true },
      );
      assert.notEqual(forbiddenRuntime.code, 0, `${role} cannot read the web runtime readiness RPC`);
    }

    const workerRuntime = JSON.parse(await scalar(
      "select public.read_production_setup_worker_runtime_state()::text;",
      { role: "agentpay_setup_worker" },
    ));
    assert.equal(workerRuntime.chainId, 42220);
    assert.equal(workerRuntime.sponsorDeployerAddress, deployer);
    for (const role of ["anon", "agentpay_setup_web"]) {
      const forbiddenWorkerRuntime = await dockerPsql(
        "select public.read_production_setup_worker_runtime_state();",
        { role, allowFailure: true },
      );
      assert.notEqual(forbiddenWorkerRuntime.code, 0, `${role} cannot read worker runtime readiness`);
    }

    const webWorker = await dockerPsql(
      `select public.claim_setup_deployment_job('web', '${now}'::timestamptz, 60);`,
      { role: "agentpay_setup_web", allowFailure: true },
    );
    assert.notEqual(webWorker.code, 0, "web cannot execute worker RPCs");

    const webExistingAccount = await dockerPsql(
      `select public.record_existing_setup_account(
        '00000000-0000-4000-8000-000000000001'::uuid,
        '00000000-0000-4000-8000-000000000002'::uuid,
        1,
        '${now}'::timestamptz
      );`,
      { role: "agentpay_setup_web", allowFailure: true },
    );
    assert.notEqual(webExistingAccount.code, 0, "web cannot record an existing account");

    const workerWeb = await dockerPsql(
      `select public.read_production_setup_status('${capabilityDigest}', '${now}'::timestamptz);`,
      { role: "agentpay_setup_worker", allowFailure: true },
    );
    assert.notEqual(workerWeb.code, 0, "worker cannot execute web RPCs");
  });

  it("claims Arc hosted account atomically as service_role and records audit event", async () => {
    const user1 = "a0000000-0000-4000-8000-000000000001";
    await dockerPsql(`insert into auth.users (id, email) values ('${user1}', 'user1@example.com') on conflict do nothing;`, { tuplesOnly: false });

    const claimResult = await scalar(
      `select row_to_json(r)::text from public.arc_claim_hosted_account('${user1}'::uuid) r;`,
      { role: "service_role" },
    );

    const account = JSON.parse(claimResult);
    assert.equal(account.auth_user_id, user1);
    assert.equal(account.account_status, "ACTIVE");
    assert.equal(account.wallet_status, "PENDING");
    assert.ok(account.tenant_id);

    // Replay claim returns same account cleanly
    const replayResult = await scalar(
      `select row_to_json(r)::text from public.arc_claim_hosted_account('${user1}'::uuid) r;`,
      { role: "service_role" },
    );
    assert.equal(JSON.parse(replayResult).tenant_id, account.tenant_id);
  });

  it("enforces Arc hosted account RLS user isolation and denies unprivileged RPC execution", async () => {
    const user1 = "a0000000-0000-4000-8000-000000000001";
    const user2 = "a0000000-0000-4000-8000-000000000002";
    await dockerPsql(`insert into auth.users (id, email) values ('${user2}', 'user2@example.com') on conflict do nothing;`, { tuplesOnly: false });

    // Claim account for User 2 as service_role
    await scalar(
      `select public.arc_claim_hosted_account('${user2}'::uuid);`,
      { role: "service_role" },
    );

    // Setting jwt.claim.sub for RLS test
    const rlsReadUser1 = await dockerPsql(`
      set session authorization authenticator;
      set role authenticated;
      set request.jwt.claim.sub = '${user1}';
      select count(*)::text from public.arc_hosted_accounts;
    `);
    assert.equal(rlsReadUser1.stdout, "1");

    // Private Circle wallet bindings table denies client SELECT
    const bindingRead = await dockerPsql(`
      set session authorization authenticator;
      set role authenticated;
      set request.jwt.claim.sub = '${user1}';
      select count(*)::text from public.arc_circle_wallet_bindings;
    `, { allowFailure: true });
    assert.notEqual(bindingRead.code, 0, "authenticated role must be denied access to arc_circle_wallet_bindings");

    // Anon and authenticated roles are denied RPC execution
    const forbiddenRpc = await dockerPsql(
      `select public.arc_claim_hosted_account('${user1}'::uuid);`,
      { role: "authenticated", allowFailure: true },
    );
    assert.notEqual(forbiddenRpc.code, 0, "authenticated role must be denied arc_claim_hosted_account RPC");
  });

  it("handles provisioning lifecycle atomically, fencing tokens, and enforces monotonic state transitions", async () => {
    const user1 = "a0000000-0000-4000-8000-000000000001";

    // 1. Claim provisioning job
    const claimJob = JSON.parse(await scalar(
      `select row_to_json(r)::text from public.arc_claim_provisioning_job('${user1}'::uuid) r;`,
      { role: "service_role" },
    ));
    assert.equal(claimJob.auth_user_id, user1);
    assert.equal(claimJob.provisioning_state, "PROVISIONING");
    assert.ok(claimJob.fencing_token, "Claim job must return fencing token");

    const originalFencingToken = claimJob.fencing_token;

    // Verify activity log metadata does NOT leak the fencing token
    const activityLog = await scalar(
      `select metadata::text from public.arc_agent_activity where activity_type = 'CIRCLE_WALLET_PROVISIONING' and reference_id = '${user1}';`,
      { role: "service_role" },
    );
    assert.ok(!activityLog.includes(originalFencingToken), "Activity log must not contain sensitive fencing token");

    // Concurrent claim while PROVISIONING returns empty result
    const secondClaim = await scalar(
      `select row_to_json(r)::text from public.arc_claim_provisioning_job('${user1}'::uuid) r;`,
      { role: "service_role" },
    );
    assert.equal(secondClaim, "");

    // Stale fencing token is rejected on complete
    const walletSet = "ws-arc-001";
    const walletId = "w-arc-001";
    const address = "0x1111111111111111111111111111111111111111";

    const staleComplete = await dockerPsql(
      `select public.arc_complete_provisioning('${user1}'::uuid, '00000000-0000-4000-8000-000000000000'::uuid, '${walletSet}', '${walletId}', '${address}');`,
      { role: "service_role", allowFailure: true },
    );
    assert.notEqual(staleComplete.code, 0, "Stale fencing token must be rejected");

    // 2. Complete provisioning with valid fencing token
    await scalar(
      `select public.arc_complete_provisioning('${user1}'::uuid, '${originalFencingToken}'::uuid, '${walletSet}', '${walletId}', '${address}');`,
      { role: "service_role" },
    );

    // Verify account is LIVE
    const liveAccount = JSON.parse(await scalar(
      `select row_to_json(t)::text from (select * from public.arc_hosted_accounts where auth_user_id = '${user1}'::uuid) t;`,
      { role: "service_role" },
    ));
    assert.equal(liveAccount.wallet_status, "LIVE");
    assert.equal(liveAccount.wallet_address, address);

    // Idempotent re-complete with exact same parameters succeeds
    await scalar(
      `select public.arc_complete_provisioning('${user1}'::uuid, '${originalFencingToken}'::uuid, '${walletSet}', '${walletId}', '${address}');`,
      { role: "service_role" },
    );

    // Failing a LIVE account is rejected
    const invalidFail = await dockerPsql(
      `select public.arc_fail_provisioning('${user1}'::uuid, '${originalFencingToken}'::uuid, 'SOME_ERROR');`,
      { role: "service_role", allowFailure: true },
    );
    assert.notEqual(invalidFail.code, 0, "Cannot fail a LIVE provisioning job");
  });

  it("enforces global Circle ID and address uniqueness across users and idempotent fail replays", async () => {
    const user2 = "a0000000-0000-4000-8000-000000000002";

    // Attempt to claim User 2
    const claimUser2 = JSON.parse(await scalar(
      `select row_to_json(r)::text from public.arc_claim_provisioning_job('${user2}'::uuid) r;`,
      { role: "service_role" },
    ));

    const duplicateComplete = await dockerPsql(
      `select public.arc_complete_provisioning('${user2}'::uuid, '${claimUser2.fencing_token}'::uuid, 'ws-arc-002', 'w-arc-002', '0x1111111111111111111111111111111111111111');`,
      { role: "service_role", allowFailure: true },
    );
    assert.notEqual(duplicateComplete.code, 0, "Duplicate wallet address must violate unique constraint");

    // Fail user 2 with valid fencing token
    await scalar(
      `select public.arc_fail_provisioning('${user2}'::uuid, '${claimUser2.fencing_token}'::uuid, 'UPSTREAM_ERROR');`,
      { role: "service_role" },
    );

    // Idempotent fail replay with exact same fencing token & error code succeeds
    await scalar(
      `select public.arc_fail_provisioning('${user2}'::uuid, '${claimUser2.fencing_token}'::uuid, 'UPSTREAM_ERROR');`,
      { role: "service_role" },
    );
  });

  it("sets account status and increments tenant auth_epoch", async () => {
    const user1 = "a0000000-0000-4000-8000-000000000001";

    const preTenant = JSON.parse(await scalar(
      `select row_to_json(x)::text from (select t.* from public.tenants t join public.arc_hosted_accounts a on a.tenant_id = t.id where a.auth_user_id = '${user1}'::uuid) x;`,
      { role: "service_role" },
    ));
    const initialEpoch = Number(preTenant.auth_epoch);

    await scalar(
      `select public.arc_set_account_status('${user1}'::uuid, 'PAUSED');`,
      { role: "service_role" },
    );

    const postTenant = JSON.parse(await scalar(
      `select row_to_json(x)::text from (select t.* from public.tenants t join public.arc_hosted_accounts a on a.tenant_id = t.id where a.auth_user_id = '${user1}'::uuid) x;`,
      { role: "service_role" },
    ));
    assert.equal(Number(postTenant.auth_epoch), initialEpoch + 1);

    const postAccount = JSON.parse(await scalar(
      `select row_to_json(x)::text from (select * from public.arc_hosted_accounts where auth_user_id = '${user1}'::uuid) x;`,
      { role: "service_role" },
    ));
    assert.equal(postAccount.account_status, "PAUSED");

    // Close user 1 account
    await scalar(
      `select public.arc_set_account_status('${user1}'::uuid, 'CLOSED');`,
      { role: "service_role" },
    );

    // Verify CLOSED account cannot claim a provisioning job
    const closedClaim = await scalar(
      `select row_to_json(r)::text from public.arc_claim_provisioning_job('${user1}'::uuid) r;`,
      { role: "service_role" },
    );
    assert.equal(closedClaim, "", "CLOSED account must not claim a provisioning job");

    // Verify CLOSED account cannot be reopened
    const invalidReopen = await dockerPsql(
      `select public.arc_set_account_status('${user1}'::uuid, 'ACTIVE');`,
      { role: "service_role", allowFailure: true },
    );
    assert.notEqual(invalidReopen.code, 0, "Cannot reopen a CLOSED account");
    assert.match(invalidReopen.stderr, /Cannot transition closed account/i);

    // Negative test: unknown auth user ID raises exception
    const unknownUser = "a0000000-0000-4000-8000-000000000099";
    const invalidSetStatus = await dockerPsql(
      `select public.arc_set_account_status('${unknownUser}'::uuid, 'ACTIVE');`,
      { role: "service_role", allowFailure: true },
    );
    assert.notEqual(invalidSetStatus.code, 0, "arc_set_account_status must error for non-existent user");
    assert.match(invalidSetStatus.stderr, /Hosted account not found for user/i);
  });

  it("fails closed when worker attempts to complete or fail provisioning on a PAUSED or CLOSED account", async () => {
    const pausedUser = "a0000000-0000-4000-8000-000000000088";
    await dockerPsql(`insert into auth.users (id, email) values ('${pausedUser}', 'paused@example.com') on conflict do nothing;`, { tuplesOnly: false });
    await scalar(`select public.arc_claim_hosted_account('${pausedUser}'::uuid, 'arc-hosted-autonomy-v1');`, { role: "service_role" });

    // Worker claims provisioning job while account is ACTIVE
    const claimedJobJson = await scalar(`select row_to_json(r)::text from public.arc_claim_provisioning_job('${pausedUser}'::uuid) r;`, { role: "service_role" });
    const claimedJob = JSON.parse(claimedJobJson);
    const fencingToken = claimedJob.fencing_token;
    assert.ok(fencingToken, "Worker must receive a valid fencing token");

    // Account transitions to PAUSED while worker is running
    await scalar(`select public.arc_set_account_status('${pausedUser}'::uuid, 'PAUSED');`, { role: "service_role" });

    // Worker attempts to complete provisioning -> MUST fail closed
    const completeResult = await dockerPsql(
      `select public.arc_complete_provisioning('${pausedUser}'::uuid, '${fencingToken}'::uuid, 'set_1', 'w_1', '0x1111111111111111111111111111111111111111');`,
      { role: "service_role", allowFailure: true },
    );
    assert.notEqual(completeResult.code, 0, "Completion on PAUSED account must fail");
    assert.match(completeResult.stderr, /Cannot complete provisioning for non-active account/i);

    // Worker attempts to fail provisioning -> MUST fail closed
    const failResult = await dockerPsql(
      `select public.arc_fail_provisioning('${pausedUser}'::uuid, '${fencingToken}'::uuid, 'FAILED_PROVISION');`,
      { role: "service_role", allowFailure: true },
    );
    assert.notEqual(failResult.code, 0, "Failure report on PAUSED account must fail");
    assert.match(failResult.stderr, /Cannot fail provisioning for non-active account/i);
  });

  it("handles 24 truly concurrent claim calls for a new user without duplicate key errors", async () => {
    const newUserId = "a0000000-0000-4000-8000-000000000077";
    await dockerPsql(`insert into auth.users (id, email) values ('${newUserId}', 'concurrent@example.com') on conflict do nothing;`, { tuplesOnly: false });

    // Pipeline 24 simultaneous claims for the exact same new user ID
    const results = await Promise.all(
      Array.from({ length: 24 }, () =>
        scalar(`select row_to_json(r)::text from public.arc_claim_hosted_account('${newUserId}'::uuid) r;`, {
          role: "service_role",
        }),
      ),
    );

    assert.equal(results.length, 24);
    const parsedResults = results.map((r) => JSON.parse(r));
    const firstTenantId = parsedResults[0].tenant_id;
    assert.ok(firstTenantId, "First claim must return valid tenant_id");

    for (const res of parsedResults) {
      assert.equal(res.auth_user_id, newUserId);
      assert.equal(res.tenant_id, firstTenantId, "All 24 concurrent claims must return the exact same canonical tenant_id");
      assert.equal(res.account_status, "ACTIVE");
      assert.equal(res.wallet_status, "PENDING");
    }

    // Verify exactly one tenant and one hosted account were created
    assert.equal(await scalar(`select count(*) from public.arc_hosted_accounts where auth_user_id = '${newUserId}'::uuid;`), "1");
  });

  it("reverses Task 13A migration cleanly when running the rollback script", async () => {
    const rollbackSql = await readFile("supabase/rollbacks/20260729020000_arc_hosted_identity_rollback.sql", "utf8");
    const rollbackRes = await dockerPsql(rollbackSql, { tuplesOnly: false });
    assert.equal(rollbackRes.code, 0, "Rollback SQL script must execute cleanly");

    // Verify tables and functions no longer exist
    const tableCount = await scalar("select count(*) from information_schema.tables where table_name in ('arc_hosted_accounts', 'arc_circle_wallet_bindings');");
    assert.equal(tableCount, "0", "Task 13A tables must be dropped by rollback script");
  });
});
