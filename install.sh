#!/usr/bin/env bash
# ==============================================================================
# OpenCode WARP Proxy & Privacy Shield Installer
# https://github.com/pritkr/opencode-warp-proxy
# ==============================================================================

set -e

echo "==> Installing OpenCode WARP Proxy & Privacy Shield..."

# 1. Check & Install Privoxy
if ! command -v privoxy >/dev/null 2>&1; then
    echo "[!] Privoxy not found. Attempting automatic installation..."
    if command -v brew >/dev/null 2>&1; then
        brew install privoxy
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -Sy --noconfirm privoxy
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update && sudo apt-get install -y privoxy
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y privoxy
    else
        echo "❌ Could not auto-install Privoxy. Please install Privoxy via your package manager first."
        exit 1
    fi
fi

# 2. Check WARP CLI
if ! command -v warp-cli >/dev/null 2>&1; then
    echo "⚠️  Cloudflare WARP (warp-cli) is not installed. Please install Cloudflare WARP to route proxy traffic."
fi

# 3. Download & Install opencode-proxy CLI
mkdir -p "$HOME/.local/bin" "$HOME/.opencode/bin"
TARGET_SCRIPT="$HOME/.local/bin/opencode-proxy"

# If running from local clone
if [[ -f "./bin/opencode-proxy" ]]; then
    cp -f "./bin/opencode-proxy" "$TARGET_SCRIPT"
else
    # Remote curl installer
    curl -fsSL "https://raw.githubusercontent.com/pritkr/opencode-warp-proxy/main/bin/opencode-proxy" -o "$TARGET_SCRIPT"
fi

chmod +x "$TARGET_SCRIPT"
ln -sf "$TARGET_SCRIPT" "$HOME/.opencode/bin/opencode-proxy" 2>/dev/null || true

# 4. Deploy Privacy Plugin across candidate directories
CANDIDATE_DIRS=(
    "$HOME/.config/opencode/plugins"
    "$HOME/.opencode/plugins"
    "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
)

for pdir in "${CANDIDATE_DIRS[@]}"; do
    mkdir -p "$pdir" 2>/dev/null || true
    if [[ -f "./plugins/privacy-shield.js" ]]; then
        cp -f "./plugins/privacy-shield.js" "${pdir}/privacy-shield.js" 2>/dev/null || true
    fi
done

# 5. Enable Proxy, Initial Reset & Configure Titles
echo "==> Initializing WARP Proxy & Randomizing Identifiers..."
"$TARGET_SCRIPT" on
"$TARGET_SCRIPT" reset
"$TARGET_SCRIPT" titles

echo ""
echo "🎉 Installation successful!"
echo "Commands available:"
echo "  opencode-proxy reset    # Rotate IP & randomize identifiers to clear rate limits (with 8-attempt verification)"
echo "  opencode-proxy rotate   # Rotate IP only"
echo "  opencode-proxy test     # Actively probe current IP quota against OpenCode DeepSeek v4.1"
echo "  opencode-proxy titles   # Configure title agent & regenerate descriptive names for untitled sessions"
echo "  opencode-proxy status   # View current proxy status & randomized profile"
echo "  opencode-proxy off      # Disable proxy"
echo "  opencode-proxy on       # Re-enable proxy"
