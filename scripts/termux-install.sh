#!/data/data/com.termux/files/usr/bin/bash
# 9Router Pro — Termux install (R15 packaging).
# Installs Node + git, clones Pro, installs deps, then hands off to the
# CLI wizard. No new artwork, no forked server path: the same
# `npm start` (custom-server.js) the desktop install uses.
# Usage:  bash termux-install.sh [--dir ~/9router-pro] [--port 20127]
set -euo pipefail

DIR="${HOME}/9router-pro"
PORT="20127"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

pkg update -y
pkg install -y nodejs git

if [ -d "$DIR/.git" ]; then
  echo "Updating existing checkout at $DIR ..."
  git -C "$DIR" pull --ff-only
else
  git clone https://github.com/giienew/9router-pro.git "$DIR"
fi

cd "$DIR"
npm install --no-audit --no-fund

echo ""
echo "Installed. Next steps:"
echo "  cd $DIR"
echo "  node cli/cli.js setup --port $PORT   # port + dashboard password (previewed first)"
echo "  npm start                            # serves on :$PORT (custom-server.js)"
echo "  node cli/cli.js doctor --port $PORT  # verify the install"
echo ""
echo "Note: on Termux the server runs only while the Termux session lives;"
echo "use 'termux-wake-lock' to keep it alive in the background."
