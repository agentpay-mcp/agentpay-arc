import { createServer } from "node:http";
import {
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

const SECURITY_HEADERS = Object.freeze({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function send(response, status, headers, body, headOnly) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
  });
  response.end(headOnly ? undefined : body);
}

function isInsideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function parseSafePath(requestUrl) {
  if (
    typeof requestUrl !== "string"
    || !requestUrl.startsWith("/")
    || requestUrl.startsWith("//")
    || requestUrl.includes("\\")
  ) {
    return undefined;
  }
  let parsed;
  let pathname;
  try {
    parsed = new URL(requestUrl, "http://arc-static.invalid");
    if (parsed.origin !== "http://arc-static.invalid") {
      return undefined;
    }
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  if (
    pathname.includes("\0")
    || pathname.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  return pathname;
}

async function resolveFile(root, pathname) {
  const requested = resolve(root, `.${pathname}`);
  if (!isInsideRoot(root, requested)) {
    return undefined;
  }
  try {
    const candidate = await realpath(requested);
    const candidateStat = await stat(candidate);
    if (isInsideRoot(root, candidate) && candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // A missing route may be an SPA route and is handled below.
  }
  if (extname(pathname) !== "") {
    return undefined;
  }
  const index = await realpath(resolve(root, "index.html"));
  return isInsideRoot(root, index) ? index : undefined;
}

function safeLogger(logger, entry) {
  try {
    logger(Object.freeze(entry));
  } catch {
    // Logging must never take down the static service.
  }
}

export async function startArcStaticServer(options) {
  const host = options?.host;
  const port = options?.port;
  const logger =
    options?.logger
    ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Static web host must be loopback");
  }
  if (
    !Number.isInteger(port)
    || port < 0
    || port > 65_535
  ) {
    throw new Error("Static web port is invalid");
  }
  const root = await realpath(options?.root ?? "");

  const server = createServer(async (request, response) => {
    const startedAt = performance.now();
    const method = request.method ?? "UNKNOWN";
    const pathname = parseSafePath(request.url);
    let status = 500;
    try {
      if (method !== "GET" && method !== "HEAD") {
        status = 405;
        send(
          response,
          status,
          { Allow: "GET, HEAD", "Cache-Control": "no-store" },
          "Method Not Allowed",
          method === "HEAD",
        );
        return;
      }
      if (pathname === "/healthz") {
        status = 200;
        send(
          response,
          status,
          {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
          },
          JSON.stringify({ status: "ok" }),
          method === "HEAD",
        );
        return;
      }
      if (pathname === undefined) {
        status = 404;
        send(
          response,
          status,
          { "Cache-Control": "no-store" },
          "Not Found",
          method === "HEAD",
        );
        return;
      }
      const file = await resolveFile(root, pathname);
      if (file === undefined) {
        status = 404;
        send(
          response,
          status,
          { "Cache-Control": "no-store" },
          "Not Found",
          method === "HEAD",
        );
        return;
      }
      const extension = extname(file).toLowerCase();
      const body = await readFile(file);
      const isHtml = extension === ".html";
      status = 200;
      send(
        response,
        status,
        {
          "Cache-Control": isHtml
            ? "no-store"
            : "public, max-age=31536000, immutable",
          "Content-Length": String(body.byteLength),
          "Content-Type":
            CONTENT_TYPES[extension] ?? "application/octet-stream",
        },
        body,
        method === "HEAD",
      );
    } catch {
      status = 500;
      if (!response.headersSent) {
        send(
          response,
          status,
          { "Cache-Control": "no-store" },
          "Service Unavailable",
          method === "HEAD",
        );
      } else {
        response.destroy();
      }
    } finally {
      safeLogger(logger, {
        event: "arc_web_request",
        method,
        path: pathname ?? "/invalid",
        status,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  return server;
}

function parseCliArguments(argv) {
  const expected = ["--host", "--port", "--root"];
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!expected.includes(key) || value === undefined || key in values) {
      throw new Error("Expected --host, --port, and --root exactly once");
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== expected.length) {
    throw new Error("Expected --host, --port, and --root exactly once");
  }
  const port = Number(values["--port"]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Static web port is invalid");
  }
  return Object.freeze({
    host: values["--host"],
    port,
    root: resolve(values["--root"]),
  });
}

function isMainModule() {
  return (
    process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const server = await startArcStaticServer(options);
    const shutdown = () => {
      server.close((error) => {
        process.exitCode = error ? 1 : 0;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.stdout.write(
      `${JSON.stringify({
        event: "arc_web_started",
        host: options.host,
        port: options.port,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        event: "arc_web_start_failed",
        error: error instanceof Error ? error.message : "Startup failed",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
