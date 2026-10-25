# OpenCode WARP Proxy & Privacy Shield 🛡️⚡

A resilient, cross-platform proxy bridge and privacy shield for [OpenCode](https://opencode.ai). Bypasses shared campus/office Wi-Fi IP rate-limits (`Free usage limit reached / Resets at 5:30 AM`) using **Cloudflare WARP** via a local **Privoxy** bridge, while randomizing tracking identifiers (`x-opencode-project`) on demand.

Works seamlessly on **macOS (Darwin)** and **Linux (Arch, CachyOS, Debian, Ubuntu, Fedora)**.

---

## The Problem

* **Shared Public IP Exhaustion:** On campus, dorm, or enterprise Wi-Fi, hundreds of devices share a single public NAT IP address. OpenCode rate-limits free-tier models (e.g. `opencode/deepseek-v4.1-flash-free`) by public IP in Upstash Redis. When the shared IP runs out of quota, everyone on the network gets blocked.
* **Bun's SOCKS5 Incompatibility:** OpenCode runs on the Bun JavaScript runtime. Bun's native `fetch()` does not support `socks5://` proxy schemes (`UnsupportedProxyProtocol`).
* **Session Correlation:** OpenCode attaches persistent project identifiers (`x-opencode-project`) and client headers across requests, preventing users from resetting their rate-limit bucket.
* **Anti-Bot Throttling:** Setting `DO_NOT_TRACK: 1` or deleting standard headers triggers anti-bot scrutiny on the inference gateway.

---

## The Solution

```
┌──────────────────────────┐
│  OpenCode CLI / Daemon   │  (Bun Runtime)
│  x-opencode-project:     │
│  [Randomized 40-char ID] │
└─────────────┬────────────┘
              │ HTTP_PROXY (http://127.0.0.1:8118)
              ▼
┌──────────────────────────┐
│      Privoxy Bridge      │  Translates HTTP Proxy -> SOCKS5
│     (127.0.0.1:8118)     │
└─────────────┬────────────┘
              │ forward-socks5 (127.0.0.1:40000)
              ▼
┌──────────────────────────┐
│   Cloudflare WARP CLI    │  Proxy Mode (Port 40000, MASQUE)
│     (127.0.0.1:40000)    │  Rotatable Egress Keys
└─────────────┬────────────┘
              │
              ▼
┌──────────────────────────┐
│   Cloudflare Anycast     │  Brand new public IP per rotation
│   Inference Gateway      │  Zero rate-limit bucket
└──────────────────────────┘
```

1. **WARP in Proxy Mode:** Runs Cloudflare WARP locally on port `40000` via MASQUE protocol without hijacking your entire system's default network routing.
2. **Privoxy SOCKS5 Bridge:** Privoxy listens on port `8118` and transparently converts OpenCode's HTTP requests to WARP's SOCKS5 interface.
3. **On-Demand Key Rotation (`reset`):** Generates new WireGuard/MASQUE cryptographic keys on demand (`warp-cli tunnel rotate-keys`), immediately acquiring a fresh public egress IP and resetting the rate-limit budget.
4. **Privacy Shield Plugin:** Injects standard-format, valid, but strictly randomized 40-character project IDs into outgoing requests. The server sees a 100% normal, valid client with **0% correlation** to past sessions. Identifiers stay stable during active sessions and only rotate when you run `opencode-proxy reset`.

---

## Quick Install (One-Liner)

Run this command in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/pritkr/opencode-warp-proxy/main/install.sh | bash
```

*Auto-detects your OS, installs Privoxy if missing, sets up the binary, deploys the plugin, and runs an initial reset.*

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `opencode-proxy reset` | **Full Reset:** Generates a new random project ID, rotates Cloudflare IP, flushes memory caches, and restarts the daemon. |
| `opencode-proxy rotate` | Rotates Cloudflare WARP egress IP only without restarting OpenCode. |
| `opencode-proxy status` | Displays WARP status, Privoxy status, egress IPs, and current active identity profile. |
| `opencode-proxy on` | Enables proxy mode in OpenCode and starts Privoxy & WARP. |
| `opencode-proxy off` | Disables proxy environment variables and routes OpenCode directly. |
| `opencode-proxy run <args>` | Wraps `opencode` with automatic 3x retry and IP rotation on rate limits. |

---

## Model Selection Gotcha

For free-tier usage, use the base model:
```bash
opencode run -m opencode/deepseek-v4.1-flash-free "Hello"
```

> [!WARNING]
> Avoid variants like `#high` or `#max` (e.g. `deepseek-v4.1-flash-free#max`) on the free tier. These compute-heavy variants trigger OpenCode Go subscription requirements (`FreeUsageLimitError`) regardless of IP.

---

## Architecture & File Locations

* **CLI Binary:** `~/.local/bin/opencode-proxy` (symlinked to `~/.opencode/bin/opencode-proxy`)
* **Privacy Plugin:** `~/.config/opencode/plugins/privacy-shield.js` (and `~/.opencode/plugins/`)
* **Active Identity:** `~/.config/opencode/identity.json`
* **Privoxy Config:** `~/.config/opencode/privoxy.conf` (or `/opt/homebrew/etc/privoxy/config`)

---

## License

[MIT](LICENSE)
