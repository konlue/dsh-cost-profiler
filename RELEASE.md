# Release checklist

How to publish `dsh-cost-profiler` — npm, GitHub and the plugin listing. All
commands run from the repository root unless noted.

## 0. Before you start

- `node --test` — all tests green (44 as of 0.1.0).
- `npm pack --dry-run` — 13 files, ~30 kB; no stray files (tests, handoff
  notes and `.workbuddy/` are not packaged).
- `npm publish --dry-run --registry https://registry.npmjs.org` — metadata
  check against the real registry (no auth needed for a dry run).
- Update the date in `CHANGELOG.md` if the publish day differs from the
  heading.

> **Registry trap:** this machine's default npm registry is npmmirror. Every
> publish/whoami/view command below must carry
> `--registry https://registry.npmjs.org`.

## 1. npm — ✅ done: 0.1.0 is live

`dsh-cost-profiler@0.1.0` was published on 2026-10-11 (latest tag; shasum
`c2415856…` matches the local dry run). The instructions below remain for
future versions.

Publishing to npmjs.com requires either 2FA or a granular access token.

**Option A — 2FA (authenticator app)**

1. npmjs.com → Account settings → Two-Factor Authentication → enable.
2. Publish with the OTP from your authenticator:

   ```
   npm publish --registry https://registry.npmjs.org --otp=123456
   ```

**Option B — Granular Access Token (no 2FA needed)**

1. npmjs.com → Account settings → Access Tokens → Generate New Token →
   **Granular Access Token**, scope *Read and write*, packages:
   `dsh-cost-profiler`, and enable **bypass 2FA** if 2FA is off.
2. Store the token for the official registry only:

   ```
   npm config set "//registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxx"
   ```

3. Publish:

   ```
   npm publish --registry https://registry.npmjs.org
   ```

**Verify**

```
npm view dsh-cost-profiler version --registry https://registry.npmjs.org
# → 0.1.0
```

**Cleanup** — the placeholder `0.0.0-stage` published during setup can be
removed (single-version unpublish is allowed within 72h of publishing and
does not touch 0.1.0):

```
npm unpublish dsh-cost-profiler@0.0.0-stage --registry https://registry.npmjs.org
```

## 2. GitHub

1. Create a new **public** repository named `dsh-cost-profiler` (empty — no
   README/LICENSE init; the repo already has both).
2. Push:

   ```
   git remote add origin git@github.com:<you>/dsh-cost-profiler.git
   git push -u origin main
   ```

3. Optional but recommended — tag and release:

   ```
   git tag v0.1.0
   git push --tags
   ```

   then create a GitHub Release for `v0.1.0` with the `CHANGELOG.md` 0.1.0
   section as the body.
4. Add the repository URL to `package.json` so the npm page links back:

   ```json
   "repository": { "type": "git", "url": "git+https://github.com/<you>/dsh-cost-profiler.git" },
   "homepage": "https://github.com/<you>/dsh-cost-profiler#readme",
   "bugs": { "url": "https://github.com/<you>/dsh-cost-profiler/issues" }
   ```

   (Commit locally; it rides along with the next published version.)

## 3. Plugin listing (awesome-dsh)

Open an issue or PR against the awesome-dsh list with a line such as:

> **[dsh-cost-profiler](https://github.com/<you>/dsh-cost-profiler)** —
> Turn-level cost & performance profiler. Per-turn/per-model/per-tool token,
> latency and cost attribution, cross-session rollups (`/cost week`), a
> model-facing `cost_report` tool, and Markdown-rendered report cards.
> Bilingual (EN/中文).

## 4. After publishing

- Install it the way a user would, from the registry instead of the local
  `file:` dependency, in a scratch profile:

  ```
  dsh plugin --profile <scratch> add dsh-cost-profiler
  ```

- Sanity-check `/cost`, `/cost week` and a `cost_report` call once more.
