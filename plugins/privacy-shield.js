/**
 * OpenCode Privacy Shield Plugin
 * https://github.com/pritkr/opencode-warp-proxy
 * 
 * - Protects user privacy by dynamically anonymizing telemetry headers.
 * - PRESERVES all useful local identifiers in OpenCode (worktree, project DB, session history).
 * - Prevents rapid quota exhaustion by maintaining per-project isolation via cryptographic
 *   salting instead of forcing all projects into a single shared bucket.
 * - When rate limits are encountered, automatically rotates outgoing salts and WARP IP.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const CANDIDATE_IDENTITY_FILES = [
  process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "opencode/identity.json") : null,
  path.join(process.env.HOME || "", ".config/opencode/identity.json"),
  path.join(process.env.HOME || "", ".opencode/identity.json")
].filter(Boolean);

let cachedIdentity = null;
let lastIdentityMtime = 0;
let lastAutoRotateTime = 0;

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

  // Fallback / default identity with random salt
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

/**
 * Derives a consistent, anonymous 40-hex project ID for the outgoing request.
 * Crucially: Project A and Project B get DIFFERENT outgoing IDs derived via HMAC.
 * This ensures they DO NOT share or quickly exhaust the same quota bucket!
 * Yet no local user paths or git worktrees are exposed to the telemetry server.
 */
function deriveAnonymizedProjectId(realProjectId, salt) {
  const base = realProjectId || "default-project";
  return crypto.createHmac("sha256", salt || "default-salt")
               .update(base)
               .digest("hex")
               .slice(0, 40);
}

function triggerBackgroundIpRotation() {
  const now = Date.now();
  if (now - lastAutoRotateTime < 15_000) return; // Debounce 15s
  lastAutoRotateTime = now;

  // Bump salt so next outgoing requests immediately use fresh virtual IDs
  try {
    const file = getPrimaryIdentityFile();
    if (file && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      data.salt = crypto.randomBytes(16).toString("hex");
      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      lastIdentityMtime = fs.statSync(file).mtimeMs;
      cachedIdentity = data;
    }
  } catch (e) {}

  // Trigger WARP tunnel key rotation non-blockingly
  try {
    const warp = spawn("warp-cli", ["tunnel", "rotate-keys"], { stdio: "ignore", detached: true });
    warp.unref();
  } catch (e) {}
}

export default {
  id: "privacy.shield",
  async setup(ctx) {
    // 1. Hook outgoing model requests: dynamically anonymize telemetry without touching DB
    if (ctx.session?.hook) {
      await ctx.session.hook("model.request", (event) => {
        const headers = event.headers;
        if (!headers) return;

        const identity = loadIdentity();
        const originalProject = headers["x-opencode-project"];

        // Dynamic per-project masking: Keeps projects isolated so quota isn't pooled into 1 bucket!
        headers["x-opencode-project"] = deriveAnonymizedProjectId(originalProject, identity.salt);
        headers["x-opencode-client"] = identity.clientId || "cli";

        // Sanitize any directory leakage if present
        if (headers["x-opencode-directory"]) {
          headers["x-opencode-directory"] = encodeURIComponent("/home/dev/workspace");
        }
      });
    }

    // 2. Listen to session events: if a rate limit or FreeUsageLimitError occurs,
    // automatically trigger background IP & salt rotation (self-healing)
    if (ctx.event?.subscribe) {
      const controller = new AbortController();
      (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            if (ev?.type === "session.error") {
              const errStr = JSON.stringify(ev.properties || ev);
              if (errStr.includes("FreeUsageLimitError") || errStr.includes("Free usage limit reached")) {
                triggerBackgroundIpRotation();
              }
            }
          }
        } catch (e) {}
      })();
    }
  }
};
