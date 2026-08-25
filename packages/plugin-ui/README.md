# TwinDesk Client plugin

This Stage 0 package proves that a private, out-of-tree package can contribute a browser component to the pinned DeepSeek Harness Profile. Its empty Host entry enrolls the package with Cordis, while `package.json#dsh.client` declares the browser graph edge and `exports["./client"]` exposes the built lazy-CJS artifact.

The browser half registers a read-only compatibility card under the `twindesk-work-hub` settings namespace. It also uses the public `sidebar.footer.action` and `conversation` slots to expose a static `#/inbox` empty-state spike. Harness renders the card only when the matching Host settings namespace is present. Neither component has connector, filesystem, model, credential, persistence, or external-write capability.

## Build contract

Run the repository build before starting the Profile:

```sh
corepack pnpm@11.7.0 run build
```

`scripts/build-client-plugin.mjs` type-checks through the normal project build, transpiles the browser entry to CommonJS, and wraps it in Harness's required `window.__ModuleLoader__.load(...)` factory. It preserves React as a shared module-table dependency and rejects any unsupported runtime request. The generated `dist/client.js` and `dist/client.js.map` are ignored build artifacts and are never committed.

`pnpm clean` removes these custom artifacts as well as TypeScript output, so a subsequent Profile launch cannot silently reuse a stale Client bundle.

The upstream Client bundle preset is not published in Harness `0.1.1-rc.2`, so this minimal builder intentionally supports only the current single-module compatibility components. A future component that adds stylesheets, cross-plugin runtime imports, or additional source modules must extend the builder deliberately or migrate to an upstream published preset.

See [`docs/INBOX_EXTENSION_SPIKE.md`](../../docs/INBOX_EXTENSION_SPIKE.md) for the exact public slots, route ownership, unstable assumptions, and remaining navigation gaps.
