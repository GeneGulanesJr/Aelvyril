#!/bin/sh
# First start seeds Aelvyril's own pi home; later starts only install what is missing.
# A failed install (e.g. offline) is reported but never stops the app; it retries next start.
home="${PI_CODING_AGENT_DIR:-/data/pi}"
mkdir -p "$home"

if [ ! -f "$home/settings.json" ]; then
  echo '{ "defaultTools": ["+codemode", "+tool_search"] }' > "$home/settings.json"
fi

# Ponytail always runs at "full" and is hidden from the Extensions list, so nothing in the UI can change it: write it on every start.
cfg="${XDG_CONFIG_HOME:-/data/config}/ponytail"
mkdir -p "$cfg"
echo '{ "defaultMode": "full" }' > "$cfg/config.json"

: "${AELVYRIL_EXTENSIONS:=git:github.com/GeneGulanesJr/LaPis git:github.com/GeneGulanesJr/PiSubagent git:github.com/DietrichGebert/ponytail}"
for pkg in $AELVYRIL_EXTENSIONS; do
  if grep -qxF "$pkg" "$home/.installed" 2>/dev/null; then continue; fi
  echo "[aelvyril] installing $pkg"
  if pi install "$pkg"; then echo "$pkg" >> "$home/.installed"; else echo "[aelvyril] could not install $pkg; will retry on next start"; fi
done

exec "$@"
