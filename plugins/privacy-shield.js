/**
 * OpenCode Privacy Shield Plugin
 * https://github.com/pritkr/opencode-warp-proxy
 * 
 * Protects user privacy and prevents telemetry correlation across sessions.
 * 
 * - Injects standard, valid OpenCode identifiers (x-opencode-project, x-opencode-client, directory)
 *   so API gateways treat requests as genuine clients without triggering anti-bot rate limits.
 * - Identifiers remain strictly STABLE throughout normal active sessions/tools.
 * - Identifiers are ONLY randomized when `opencode-proxy reset` is executed.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const possibleIdentityFiles = [
  path.join(process.env.HOME || "", ".config/opencode/identity.json"),
  path.join(process.env.HOME || "", ".opencode/identity.json"),
  process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "opencode/identity.json") : null
].filter(Boolean);

let cachedIdentity = null;

function loadIdentity() {
  for (const file of possibleIdentityFiles) {
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (data && data.projectId) {
          return data;
        }
      }
    } catch (e) {}
  }

  // Fallback: create and persist if missing
  const newIdentity = {
    projectId: crypto.randomBytes(20).toString("hex"),
    clientId: "cli",
    directory: "/home/dev/workspace",
    createdAt: new Date().toISOString()
  };

  for (const file of possibleIdentityFiles) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(newIdentity, null, 2));
      break;
    } catch (e) {}
  }

  return newIdentity;
}

function getIdentity() {
  if (!cachedIdentity) {
    cachedIdentity = loadIdentity();
  }
  return cachedIdentity;
}

export default {
  id: "privacy.shield",
  async setup(ctx) {
    if (ctx.session?.hook) {
      await ctx.session.hook("model.request", async (req) => {
        if (req.headers) {
          const identity = getIdentity();

          // Standard identifiers kept constant per session, refreshed only on `reset`
          if (identity.projectId) {
            req.headers["x-opencode-project"] = identity.projectId;
          }
          req.headers["x-opencode-client"] = identity.clientId || "cli";

          if (req.headers["x-opencode-directory"]) {
            req.headers["x-opencode-directory"] = encodeURIComponent(identity.directory || "/home/dev/workspace");
          }
        }
      });
    }
  }
};
