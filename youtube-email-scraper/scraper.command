#!/bin/bash
# Double-click this file to run the YouTube email scraper end-to-end.
# macOS may show "cannot open" the first time -- if so, right-click -> Open.
#
# Requirements (one-time):
#   1) Python 3 from https://www.python.org/downloads/macos/  (no Xcode needed)
#   2) Google Chrome from https://www.google.com/chrome/

cd "$(dirname "$0")"

clear
echo "===================================================="
echo "  YouTube Email Scraper -- Ekko Outreach"
echo "===================================================="
echo ""

# --- Find a working Python 3 -----------------------------------------------
PYTHON=""
for p in /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
         /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
         /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
         /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
         /opt/homebrew/bin/python3 \
         /usr/local/bin/python3; do
    if [ -x "$p" ]; then
        PYTHON="$p"
        break
    fi
done

# Fallback to PATH python3, but verify it actually runs (not the xcode stub)
if [ -z "$PYTHON" ] && command -v python3 >/dev/null 2>&1; then
    if python3 -c "print(1)" >/dev/null 2>&1; then
        PYTHON="$(command -v python3)"
    fi
fi

if [ -z "$PYTHON" ]; then
    echo "Python 3 isn't installed (or only the Xcode stub is present)."
    echo ""
    echo "Opening python.org in your browser. Do this:"
    echo "  1. Click the big yellow 'Download Python 3.x.x' button."
    echo "  2. When the .pkg downloads, open it from your Downloads folder."
    echo "  3. Click Continue / Agree / Install in the installer."
    echo "  4. When it finishes, double-click this scraper.command again."
    open "https://www.python.org/downloads/macos/"
    echo ""
    echo "Press any key to close this window..."
    read -n 1 -s
    exit 1
fi
echo "[OK] Python: $PYTHON"

# --- Check Chrome -----------------------------------------------------------
if [ ! -d "/Applications/Google Chrome.app" ]; then
    echo ""
    echo "Google Chrome isn't installed. Opening download page."
    open "https://www.google.com/chrome/"
    echo "Install Chrome, then double-click this file again."
    echo "Press any key to close..."
    read -n 1 -s
    exit 1
fi
echo "[OK] Chrome"
echo ""

# --- Install Python deps ----------------------------------------------------
echo "Installing Python dependencies (first run only takes a minute)..."
"$PYTHON" -m pip install --quiet --upgrade pip 2>&1 | tail -1
"$PYTHON" -m pip install --quiet --upgrade -r requirements.txt 2>&1 | tail -1
echo "[OK] dependencies"
echo ""

# --- Prompt for the run -----------------------------------------------------
echo "===================================================="
echo "  What niche do you want to find creators in?"
echo "===================================================="
echo "Examples:"
echo "  finance creator"
echo "  fitness coach"
echo "  long form podcast"
echo "  online business"
echo "  productivity youtube"
echo ""
read -r -p "Search query: " QUERY
if [ -z "$QUERY" ]; then
    echo "No query entered. Exiting."
    read -n 1 -s
    exit 1
fi
echo ""
read -r -p "How many channels to find? [default 50]: " MAXCH
MAXCH=${MAXCH:-50}
echo ""
echo "Running: discover '$QUERY' (max $MAXCH) -> scrape emails -> build drafts.txt"
echo ""

# --- Run the scraper --------------------------------------------------------
"$PYTHON" scraper.py --discover "$QUERY" --max "$MAXCH" --gen-drafts

# --- Done -------------------------------------------------------------------
echo ""
echo "===================================================="
echo "  All done!"
echo "===================================================="
echo ""
echo "Files in this folder:"
echo "  youtube_leads.csv -- the scraped emails"
echo "  drafts.txt        -- copy-paste each draft into Gmail"
echo ""
echo "Press any key to close this window..."
read -n 1 -s
