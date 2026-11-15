#!/usr/bin/env bash
# Stop on failed commands, unset variables, or failures within pipelines.
set -euo pipefail

# Run from the repository root, regardless of the caller's current directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Preserve a custom Vite+ location, or default to ~/.vite-plus; expose it to children.
export VP_HOME="${VP_HOME:-$HOME/.vite-plus}"

# Install Vite+ only when its executable is missing from that location.
if [[ ! -x "$VP_HOME/bin/vp" ]]; then
  # Create a uniquely named temporary file for the installer.
  installer="$(mktemp)"
  
  # Delete the temporary installer when this script exits, including on failure.
  trap 'rm -f "$installer"' EXIT
  
  # Download the official installer; fail on HTTP errors and follow redirects.
  curl -fsSL https://vite.plus -o "$installer"
  
  # Use noninteractive setup, pin Vite+ to 1.6.0, and enable Node management.
  # The continuation line selects the repository's Node version and runs Bash.
  CI=1 VP_VERSION=1.6.0 VP_NODE_MANAGER=yes \
    VP_SETUP_NODE_VERSION="$(cat .node-version)" bash "$installer"
fi

# Tell ShellCheck not to inspect this generated, machine-specific environment file.
# Load Vite+'s PATH settings and shell helpers into this shell.
source "$VP_HOME/env"

# Install workspace dependencies without changing the committed lockfile.
vp install --frozen-lockfile

# Generate TypeScript declarations for the Workers' configured bindings.
vpr cf:types

# Only Linux needs this system-package installation step.
if [[ "$(uname -s)" == "Linux" ]]; then
  # Install Chromium's required system libraries; Playwright may request sudo.
  vp exec playwright install-deps chromium
fi

# Download the Chromium browser version required by the installed Playwright.
vp exec playwright install chromium

# Show how to load Vite+ in the caller's shell; sourcing here affects only this script.
printf '\nSetup complete. Load Vite+ in your shell with:\nsource "%s/env"\n' "$VP_HOME"
