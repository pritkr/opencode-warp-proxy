/**
 * OpenCode Native Auto-Resume & Session Supervisor Plugin
 * https://github.com/pritkr/opencode-warp-proxy
 * 
 * - Seamlessly and natively resumes interrupted OpenCode threads.
 * - Handles transient network drops, upstream timeouts, process restarts,
 *   and rate-limit cooldowns directly inside the OpenCode runtime.
 * - Uses native SessionRunner retry hooks and event subscriptions.
 * - Runs a lightweight watchdog loop to revive idle/interrupted subagent tasks.
 * - Built-in throttling and loop protection to prevent runaway retry cycles.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const LOG_FILE = path.join(
  process.env.HOME || "",
  ".local/share/opencode/log/auto-resume.log"
);

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
  console.log(`[auto-resume] ${msg}`);
}

// Track resume attempts per session to guard against runaway loops
// Map: sessionID -> { count: number, lastTime: number, active: boolean }
const sessionTracker = new Map();

const MAX_RETRIES_PER_WINDOW = 15;
const WINDOW_MS = 600_000; // 10 minutes
const MIN_COOLDOWN_MS = 3_000;

function canResumeSession(sessionID) {
  if (!sessionID) return false;

  const now = Date.now();
  let entry = sessionTracker.get(sessionID);

  if (!entry || (now - entry.lastTime > WINDOW_MS)) {
    entry = { count: 0, lastTime: 0, active: false };
    sessionTracker.set(sessionID, entry);
  }

  if (entry.count >= MAX_RETRIES_PER_WINDOW) {
    log(`Session ${sessionID} reached retry cap (${entry.count}/${MAX_RETRIES_PER_WINDOW}). Pausing auto-resume.`);
    return false;
  }

  if (now - entry.lastTime < MIN_COOLDOWN_MS) {
    return false;
  }

  return true;
}

function recordResumeAttempt(sessionID) {
  const now = Date.now();
  let entry = sessionTracker.get(sessionID);
  if (!entry) {
    entry = { count: 0, lastTime: 0, active: false };
    sessionTracker.set(sessionID, entry);
  }
  entry.count += 1;
  entry.lastTime = now;
  return entry.count;
}

async function dispatchResumePrompt(ctx, sessionID, reason, delayMs = 1500) {
  if (!sessionID || !ctx.session?.prompt) return;

  if (!canResumeSession(sessionID)) return;
  const attempt = recordResumeAttempt(sessionID);

  log(`Scheduling native resume for session ${sessionID} (reason: ${reason}, attempt: ${attempt}) in ${delayMs}ms...`);

  setTimeout(async () => {
    try {
      await ctx.session.prompt({
        sessionID: sessionID,
        text: "Please continue where you left off.",
        resume: true
      });
      log(`✓ Dispatched native resume prompt to session ${sessionID}`);
    } catch (err) {
      log(`✗ Resume prompt error on ${sessionID}: ${err.message}`);
    }
  }, delayMs);
}

function isQuotaOrRateLimit(err) {
  if (!err) return false;
  const str = typeof err === "string" ? err : JSON.stringify(err);
  return /provider\.free-limit|provider\.rate-limit|provider\.quota|Free usage limit reached|Rate limit|rate-limit|429/i.test(str);
}

export default {
  id: "native.auto-resume",
  async setup(ctx) {
    log("Native OpenCode Auto-Resume Supervisor initialized");

    // 1. Hook native model retry decisions during active turns
    if (ctx.session?.hook) {
      await ctx.session.hook("retry", async (event) => {
        if (!event) return;
        const err = event.error;
        const attempt = event.attempt || 1;

        // If rate limit / quota cooldown: wait longer to let quota window reset
        let delay = isQuotaOrRateLimit(err) ? 15000 : Math.min(1500 * Math.pow(1.5, attempt), 25000);

        log(`Model retry hook fired for session ${event.sessionID} (attempt: ${attempt}, delay: ${delay}ms)`);

        event.decision = {
          retry: true,
          delay: delay
        };
      });
    }

    // 2. Event stream subscriber: handle turn completions, failures & interruptions
    if (ctx.event?.subscribe) {
      const controller = new AbortController();
      (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            if (!ev) continue;
            const evType = ev.type || "";
            const sessionID = ev.properties?.sessionID || ev.sessionID || ev.data?.sessionID;

            if (
              evType === "session.error" ||
              evType === "session.execution.failed" ||
              evType === "session.execution.interrupted" ||
              evType === "session.step.failed"
            ) {
              const errStr = JSON.stringify(ev.properties || ev);
              const delay = isQuotaOrRateLimit(errStr) ? 15000 : 2000;
              log(`Detected terminal event [${evType}] on session ${sessionID}. Queuing auto-resume...`);
              await dispatchResumePrompt(ctx, sessionID, evType, delay);
            }
          }
        } catch (e) {
          log(`Event subscriber error: ${e.message}`);
        }
      })();
    }

    // 3. Resilient Background Watchdog: checks every 15s for stalled/interrupted threads
    const watchdogInterval = setInterval(async () => {
      try {
        const dbPath = path.join(process.env.HOME || "", ".local/share/opencode/opencode.db");
        if (!fs.existsSync(dbPath)) return;

        // Query active unarchived sessions where last message was an assistant turn with an unhandled failure
        const sql = `
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
          LIMIT 6;
        `;

        execFile("sqlite3", [dbPath, sql], (err, stdout) => {
          if (err || !stdout) return;
          const sids = stdout.trim().split("\n").map(s => s.trim()).filter(Boolean);
          for (const sid of sids) {
            dispatchResumePrompt(ctx, sid, "watchdog-idle-check", 1000);
          }
        });
      } catch (e) {}
    }, 15000);

    watchdogInterval.unref?.();
  }
};
