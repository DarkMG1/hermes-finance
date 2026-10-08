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
`age` to `HERMES_BACKUP_AGE_RECIPIENT`, keeping 14 daily + 12 monthly. Restore never overwrites:

    npm run backup -- restore --archive hermes-<stamp>.db.age --identity <age identity> --out restored.db

One-time import from Actual Budget (`ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`):

    npm run migrate:actual -- --init-mapping map.json
    npm run migrate:actual -- --dry-run --mapping map.json --cutover YYYY-MM-DD
    npm run migrate:actual -- --apply   --mapping map.json --cutover YYYY-MM-DD   # with the service stopped
