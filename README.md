# Hermes

Personal finance app for one person: Plaid bank sync into a SQLite ledger, with an
iOS app. See `docs/specs/` for the design.

    nvm use && npm ci
    git config core.hooksPath .githooks   # gitleaks on every commit (brew install gitleaks)
    npm run check
