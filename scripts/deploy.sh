#!/usr/bin/env bash
# Deploy the committed HEAD to the VPS: copy, install deps on the host, back up, switch, restart, verify.
set -euo pipefail

HOST="${HERMES_DEPLOY_HOST:?set HERMES_DEPLOY_HOST to the ssh host alias}"
SSH=(ssh -o BatchMode=yes -o LogLevel=ERROR "$HOST")

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "deploy: working tree is not clean" >&2
  exit 1
fi
SHA="$(git rev-parse HEAD)"
echo "deploy: $SHA -> $HOST"

# shellcheck disable=SC2016 # $HOME must expand on the host, not here
live="$("${SSH[@]}" 'readlink "$HOME/hermes/current" 2>/dev/null || true')"
if [[ "$live" == */releases/"$SHA" ]]; then
  echo "deploy: $SHA is already live; restart with systemctl --user restart hermes.service" >&2
  exit 1
fi

git archive --format=tar "$SHA" package.json package-lock.json .nvmrc shared server ops |
  "${SSH[@]}" "set -e; d=\"\$HOME/hermes/releases/$SHA.tmp\"; rm -rf \"\$d\"; mkdir -p \"\$d\"; tar -x -C \"\$d\""

"${SSH[@]}" 'bash -s' "$SHA" <<'REMOTE'
set -euo pipefail
sha="$1"
root="$HOME/hermes"
rel="$root/releases/$sha"
envfile="$HOME/.config/hermes/hermes.env"
test -f "$envfile" || { echo "deploy: missing $envfile" >&2; exit 1; }

cd "$rel.tmp"
"$HOME/.npm-global/bin/npm" ci --omit=dev --no-audit --no-fund --loglevel=error
cd "$root"
rm -rf "$rel"
mv "$rel.tmp" "$rel"

mkdir -p "$root/data" "$root/backups" "$HOME/.config/systemd/user"
chmod 700 "$root/data" "$root/backups"
cp "$rel/ops/hermes.service" "$rel/ops/hermes-backup.service" "$rel/ops/hermes-backup.timer" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload

if [ -f "$root/data/hermes.db" ]; then
  (cd "$rel" && /usr/bin/node --env-file="$envfile" server/src/backup-cli.ts backup)
fi

schema_version() {
  (cd "$1" && /usr/bin/node -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.prepare('SELECT MAX(version) AS v FROM migrations').get().v ?? 0)" "$root/data/hermes.db" 2>/dev/null) || echo unknown
}
before="$(schema_version "$rel")"

prev="$(readlink "$root/current" 2>/dev/null || true)"
ln -sfn "$rel" "$root/current.new"
mv -T "$root/current.new" "$root/current"
printf 'HERMES_GIT_SHA=%s\n' "$sha" > "$root/release.env"

systemctl --user enable hermes.service >/dev/null
systemctl --user enable --now hermes-backup.timer >/dev/null
systemctl --user restart hermes.service

port="$(sed -n 's/^HERMES_PORT=//p' "$envfile")"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port:-5010}/v1/health" 2>/dev/null | grep -q "\"gitSha\":\"$sha\""; then
    echo "deploy: healthy at $sha (previous: ${prev:-none})"
    find "$root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2- | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done
echo "deploy: /v1/health did not report $sha" >&2
if [ -n "$prev" ]; then
  if ! systemctl --user stop hermes.service; then
    echo "deploy: rollback failed: could not stop the failed service" >&2
    exit 1
  fi
  after="$(schema_version "$rel")"
  if [ "$before" != unknown ] && [ "$before" = "$after" ]; then
    previous_sha="$(basename "$prev")"
    if ln -sfn "$prev" "$root/current.new" && mv -T "$root/current.new" "$root/current" &&
      printf 'HERMES_GIT_SHA=%s\n' "$previous_sha" > "$root/release.env" && systemctl --user start hermes.service; then
      for _ in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:${port:-5010}/v1/health" 2>/dev/null | grep -q "\"gitSha\":\"$previous_sha\""; then
          echo "deploy: rolled back to $previous_sha (schema unchanged at version $before)" >&2
          exit 1
        fi
        sleep 1
      done
    fi
    echo "deploy: rollback failed: previous release did not become healthy" >&2
  elif [ "$before" = unknown ] || [ "$after" = unknown ]; then
    echo "deploy: could not read the schema version; restore the pre-deploy backup before restarting the previous release" >&2
  else
    echo "deploy: schema changed $before -> $after; restore the pre-deploy backup before restarting the previous release" >&2
  fi
  if systemctl --user stop hermes.service; then
    echo "deploy: hermes.service is stopped" >&2
  else
    echo "deploy: could not confirm hermes.service is stopped; check its status before recovery" >&2
  fi
  echo "restart previous release (restore the pre-deploy backup first if the schema changed or could not be read):" >&2
  echo "  ln -sfn '$prev' '$root/current.new' && mv -T '$root/current.new' '$root/current' && printf 'HERMES_GIT_SHA=%s\n' '$(basename "$prev")' > '$root/release.env' && systemctl --user start hermes.service" >&2
  echo "restart new release:" >&2
  echo "  ln -sfn '$rel' '$root/current.new' && mv -T '$root/current.new' '$root/current' && printf 'HERMES_GIT_SHA=%s\n' '$sha' > '$root/release.env' && systemctl --user start hermes.service" >&2
fi
exit 1
REMOTE
