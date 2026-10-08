# Hermes

Personal finance app for one person: Plaid bank sync into a SQLite ledger, with an
iOS app.

    nvm use && npm ci
    git config core.hooksPath .githooks   # gitleaks on every commit (brew install gitleaks)
    npm run check

## Operations

The server runs as a systemd user service on one host, bound to loopback.

    HERMES_DEPLOY_HOST=<ssh alias> scripts/deploy.sh   # deploy committed HEAD

Host layout: `~/hermes/releases/<sha>`, `~/hermes/current` (symlink), `~/hermes/data/hermes.db`,
`~/hermes/backups`, secrets in `~/.config/hermes/hermes.env` (see `.env.example`). Units live in `ops/`.

Backups run nightly (`hermes-backup.timer`): an online SQLite backup, integrity-checked, encrypted with
`age` to `HERMES_BACKUP_AGE_RECIPIENT`, keeping the newest of each of the last 14 days + 12 months.
Restore never overwrites; write the output inside the mode-700 `~/hermes/data` (it is plaintext):

    npm run backup -- restore --archive hermes-<stamp>.db.age --identity <age identity> --out ~/hermes/data/restored.db

Then swap it in:

    systemctl --user stop hermes.service
    cd ~/hermes/data && aside="pre-restore-$(date -u +%Y%m%dT%H%M%SZ)" && mkdir "$aside"
    for f in hermes.db hermes.db-wal hermes.db-shm; do [ -e "$f" ] && mv "$f" "$aside/"; done
    mv restored.db hermes.db
    systemctl --user start hermes.service
    curl -fsS http://127.0.0.1:<HERMES_PORT>/v1/health

One-time import from Actual Budget (`ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`):

    npm run migrate:actual -- --init-mapping map.json
    npm run migrate:actual -- --dry-run --mapping map.json --cutover YYYY-MM-DD
    npm run migrate:actual -- --apply   --mapping map.json --cutover YYYY-MM-DD   # with the service stopped

A mapping entry may set its own `"cutover": "YYYY-MM-DD"` (default: `--cutover`), and `--adjust` books any remaining gap between the imported history and a checking/savings or credit balance as one `Balance adjustment (migration)` row in Transfers, excluded from spending.

The iPhone app reaches the server through a reverse proxy with TLS: see `ops/nginx-hermes.conf.example`.
The server itself stays bound to 127.0.0.1; every API call needs the bearer token.
