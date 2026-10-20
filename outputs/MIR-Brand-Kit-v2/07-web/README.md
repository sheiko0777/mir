# MIR interface previews

All data are MOCK SAMPLE and illustrative. These pages do not connect to a wallet, RPC or live trading engine.

Serve the kit directory with a local HTTP server and open `07-web/index.html`. The handoff includes a dependency-free Node server. Native web components are in components.js; semantic tokens in ../03-tokens. Theme toggle, pool filtering, evidence dialogs and sample JSON export work locally. No package installation is required.

Integration: keep mockPools confined to preview routes. Real engine observations require source/block/freshness and risk reasons before being mapped into UI. Never replace unknown values with zero or a green status. Use textContent for untrusted token names.
