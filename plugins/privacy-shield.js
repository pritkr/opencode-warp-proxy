/**
 * OpenCode Privacy Shield & Durable Auto-Resume Supervisor Plugin
 * https://github.com/pritkr/opencode-warp-proxy
 * 
 * - Anonymizes telemetry headers per project using cryptographic HMAC salting.
 * - Preserves all useful local identifiers in OpenCode (project DB, worktree, session history).
 * - Hooks "retry" and subscribes to session lifecycle events to automatically recover
 *   from rate limits, network resets, timeouts, and interruptions.
 * - Includes a background watchdog supervisor that detects any stalled or failed threads
 *   and automatically dispatches in-thread resume prompts.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const CANDIDATE_IDENTITY_FILES = [
  process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "opencode/identity.json") : null,
  path.join(process.env.HOME || "", ".config/opencode/identity.json"),
  path.join(process.env.HOME || "", ".opencode/identity.json")
].filter(Boolean);

const LOG_FILE = path.join(
  process.env.HOME || "",
  ".local/share/opencode/log/privacy-shield.log"
);

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
  console.log(`[privacy-shield] ${msg}`);
}

function findProxyBin() {
  const candidates = [
    path.join(process.env.HOME || "", ".local/bin/opencode-proxy"),
    path.join(process.env.HOME || "", ".opencode/bin/opencode-proxy"),
    "/usr/local/bin/opencode-proxy"
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "opencode-proxy";
}

let cachedIdentity = null;
let lastIdentityMtime = 0;
let isRotating = false;

// Per-session resume tracking for exponential backoff & loop protection
const resumeState = new Map(); // sessionID -> { count: number, lastTime: number }

function getPrimaryIdentityFile() {
  for (const file of CANDIDATE_IDENTITY_FILES) {
    if (fs.existsSync(file)) return file;
  }
  return CANDIDATE_IDENTITY_FILES[0];
}

function loadIdentity() {
  const file = getPrimaryIdentityFile();
  try {
    if (file && fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (cachedIdentity && stat.mtimeMs === lastIdentityMtime) {
        return cachedIdentity;
      }
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (data && data.salt) {
        lastIdentityMtime = stat.mtimeMs;
        cachedIdentity = data;
        return cachedIdentity;
      }
    }
  } catch (e) {}

  const newIdentity = {
    salt: crypto.randomBytes(16).toString("hex"),
    clientId: "cli",
    updatedAt: new Date().toISOString()
  };

  try {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(newIdentity, null, 2));
      lastIdentityMtime = fs.statSync(file).mtimeMs;
    }
  } catch (e) {}

  cachedIdentity = newIdentity;
  return newIdentity;
}

function bumpSalt() {
  try {
    const file = getPrimaryIdentityFile();
    if (file && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      data.salt = crypto.randomBytes(16).toString("hex");
      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      lastIdentityMtime = fs.statSync(file).mtimeMs;
      cachedIdentity = data;
      log(`Rotated telemetry salt -> ${data.salt}`);
    }
  } catch (e) {
    log(`Failed to bump salt: ${e.message}`);
  }
}

function deriveAnonymizedProjectId(realProjectId, salt) {
  const base = realProjectId || "default-project";
  return crypto.createHmac("sha256", salt || "default-salt")
               .update(base)
               .digest("hex")
               .slice(0, 40);
}

function runProxyRotate() {
  if (isRotating) {
    log("Proxy rotation already in progress, queuing...");
    return Promise.resolve();
  }
  isRotating = true;
  const proxyBin = findProxyBin();
  log(`Executing ${proxyBin} rotate...`);

  return new Promise((resolve) => {
    execFile(proxyBin, ["rotate"], { timeout: 35000 }, (error, stdout, stderr) => {
      isRotating = false;
      if (error) {
        log(`opencode-proxy rotate failed: ${error.message}\n${stderr || ""}`);
      } else {
        log(`opencode-proxy rotate completed successfully:\n${stdout.trim()}`);
      }
      bumpSalt();
      resolve();
    });
  });
}

function isQuotaOrRateLimitError(err) {
  if (!err) return false;
  const str = typeof err === "string" ? err : JSON.stringify(err);
  return /FreeUsageLimitError|Free usage limit reached|RateLimit|rate-limit|used today's free messages|QuotaExceeded|provider\.free-limit|provider\.rate-limit|provider\.quota|429/i.test(str);
}

function isRecoverableError(err) {
  if (!err) return false;
  const str = typeof err === "string" ? err : JSON.stringify(err);
  return isQuotaOrRateLimitError(err) ||
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Timed out|Connection lost|aborted|Step interrupted|socket.*closed/i.test(str);
}

function cleanSQLiteErrors() {
  try {
    const dbPath = path.join(process.env.HOME || "", ".local/share/opencode/opencode.db");
    if (fs.existsSync(dbPath)) {
      execFile("sqlite3", [dbPath, "DELETE FROM session_message WHERE data LIKE '%FreeUsageLimitError%';"], () => {});
    }
  } catch (e) {}
}

async function resumeSession(ctx, sessionID, reason, delayMs = 1500) {
  if (!sessionID || !ctx.session?.prompt) return false;

  const now = Date.now();
  let state = resumeState.get(sessionID);
  if (!state || (now - state.lastTime > 600_000)) {
    // Reset attempt counter after 10 minutes of quiet
    state = { count: 0, lastTime: 0 };
    resumeState.set(sessionID, state);
  }

  const MAX_RETRIES = 12;
  if (state.count >= MAX_RETRIES) {
    log(`Session ${sessionID} reached max resume retries (${state.count}). Skipping automatic trigger.`);
    return false;
  }

  // Throttle rapid re-prompts within 4 seconds
  if (now - state.lastTime < 4000) {
    log(`Session ${sessionID} resumed recently (${now - state.lastTime}ms ago). Throttling...`);
    return false;
  }

  state.count += 1;
  state.lastTime = now;

  log(`[auto-resume] Scheduling resume for session ${sessionID} (reason: ${reason}, attempt: ${state.count}/${MAX_RETRIES}) in ${delayMs}ms...`);

  setTimeout(async () => {
    try {
      await ctx.session.prompt({
        sessionID: sessionID,
        text: "Please continue where you left off.",
        resume: true
      });
      log(`[auto-resume] Successfully dispatched resume prompt for session ${sessionID}`);
    } catch (promptErr) {
      log(`[auto-resume] Resume prompt failed for session ${sessionID}: ${promptErr.message}`);
    }
  }, delayMs);

  return true;
}

export default {
  id: "privacy.shield",
  async setup(ctx) {
    log("Privacy Shield & Durable Auto-Resume Plugin initialized");

    // 1. Hook outgoing model requests: dynamically anonymize telemetry without touching DB
    if (ctx.session?.hook) {
      await ctx.session.hook("model.request", (event) => {
        const headers = event.headers;
        if (!headers) return;

        const identity = loadIdentity();
        const originalProject = headers["x-opencode-project"];

        headers["x-opencode-project"] = deriveAnonymizedProjectId(originalProject, identity.salt);
        headers["x-opencode-client"] = identity.clientId || "cli";

        if (headers["x-opencode-directory"]) {
          headers["x-opencode-directory"] = encodeURIComponent("/home/dev/workspace");
        }
      });

      // 2. Hook model retry decision: if rate limit / quota error occurs during execution,
      // execute `opencode-proxy rotate` and command OpenCode's SessionRunner to retry in-place!
      await ctx.session.hook("retry", async (event) => {
        if (!event) return;
        const err = event.error;
        if (isQuotaOrRateLimitError(err)) {
          log(`Detected rate limit in thread (session: ${event.sessionID}, attempt: ${event.attempt}). Automatically executing proxy rotate...`);
          
          await runProxyRotate();
          cleanSQLiteErrors();

          event.decision = {
            retry: true,
            delay: 1500
          };
          log(`Configured in-thread retry decision: { retry: true, delay: 1500 } for session ${event.sessionID}`);
        }
      });
    }

    // 3. Listen to all session lifecycle events: handle post-turn errors & interruptions
    if (ctx.event?.subscribe) {
      const controller = new AbortController();
      (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            if (!ev) continue;
            const evType = ev.type || "";
            
            if (
              evType === "session.error" ||
              evType === "session.execution.failed" ||
              evType === "session.execution.interrupted" ||
              evType === "session.step.failed"
            ) {
              const sessionID = ev.properties?.sessionID || ev.sessionID || ev.data?.sessionID;
              const errStr = JSON.stringify(ev.properties || ev);

              if (isQuotaOrRateLimitError(errStr)) {
                log(`Lifecycle event [${evType}] with quota error on ${sessionID}. Rotating proxy...`);
                await runProxyRotate();
                cleanSQLiteErrors();
                await resumeSession(ctx, sessionID, `${evType}:quota-limit`, 2000);
              } else if (isRecoverableError(errStr) || evType === "session.execution.interrupted") {
                log(`Lifecycle event [${evType}] recoverable on ${sessionID}. Triggering resume...`);
                await resumeSession(ctx, sessionID, evType, 2000);
              }
            }
          }
        } catch (e) {
          log(`Event loop subscription error: ${e.message}`);
        }
      })();
    }

    // 4. Background Watchdog Supervisor: periodically checks active sessions
    // to revive any threads that stopped unexpectedly without an active worker
    const supervisorInterval = setInterval(async () => {
      try {
        const dbPath = path.join(process.env.HOME || "", ".local/share/opencode/opencode.db");
        if (!fs.existsSync(dbPath)) return;

        // Query active unarchived sessions where last message was an assistant turn that had an error or idle_outcome='failed'
        const checkSql = `
          SELECT s.id
          FROM session_v2 s
          JOIN (
            SELECT session_id, max(seq) as max_seq
            FROM session_message
            GROUP BY session_id
          ) latest ON latest.session_id = s.id
          JOIN session_message m ON m.session_id = s.id AND m.seq = latest.max_seq
          WHERE s.time_archived IS NULL
            AND (
              json_extract(m.data, '$.error.type') IS NOT NULL
              OR s.idle_outcome = 'failed'
            )
            AND s.time_updated < (strftime('%s','now') * 1000 - 15000)
          LIMIT 5;
        `;

        execFile("sqlite3", [dbPath, checkSql], (err, stdout) => {
          if (err || !stdout) return;
          const sids = stdout.trim().split("\n").map(s => s.trim()).filter(Boolean);
          for (const sid of sids) {
            resumeSession(ctx, sid, "watchdog-idle-failed", 1000);
          }
        });
      } catch (e) {}
    }, 20000);

    supervisorInterval.unref?.();
  }
};
