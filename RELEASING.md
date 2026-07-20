# Releasing / bumping the SDK version

This is the checklist for cutting a new version of
`@openmaxai/openmax-agent-sdk`. Follow it exactly — the version string lives in
more than one place on purpose, and CI will fail if they drift.

## 1. Files to change on every version bump

| File | What to change | Enforced by |
| --- | --- | --- |
| `package.json` | `version` field | `release.yml` refuses to publish unless the git tag matches this |
| `package-lock.json` | root `version` **and** `packages[""].version` — just run `npm install` to regenerate both | — |
| `src/index.js` | the `SDK_VERSION` **literal** — must equal `package.json` `version` | `src/version.test.js` (CI fails on any mismatch) |
| `README.md` | the "first stable release" note near the top and the release-summary paragraph near the bottom, **if** the human-facing notes change | — (prose; not machine-checked) |

That's the whole set. A single `npm install` after editing `package.json`
handles the lockfile; the other two are hand edits.

## 2. Do NOT

- **Do not turn `SDK_VERSION` back into a runtime read of `package.json`**
  (e.g. `createRequire(import.meta.url)('../package.json').version`). It reads
  cleanly when the SDK runs from its own installed package, but it does **not
  survive bundling**: a consumer that inlines the SDK into a self-contained
  artifact carries the read into their bundle, where `../package.json` fails to
  resolve at load time. That regression is exactly why `SDK_VERSION` is a
  literal today. Keep it a literal; `src/version.test.js` is the drift guard so
  you get the anti-drift guarantee without the runtime read.
- **Do not touch these — they are not the package version:**
  - `src/orchestrator.js` `reporters.version` (a reporter payload default,
    supplied by the host adapter).
  - `CONTRACT.md` / `schemas/v1/**` `version` fields — the protocol contract is
    versioned **independently** of the npm package.

## 3. Release steps

1. Branch off `main`; bump the files in §1.
2. Verify locally: `npm test` (must be green, incl. the `SDK_VERSION` drift
   guard) and — if you touched anything the scanners see — the same Semgrep
   command CI runs.
3. Push, open a PR. **Required CI must pass**: `test (node 20)`,
   `test (node 22)`, `semgrep`, `gitleaks`. Get an approval from **someone
   other than the last pusher** (org branch ruleset). Merge to `main`.
4. Tag the merged commit and push the tag:
   ```bash
   git tag -a vX.Y.Z <merged-main-sha> -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
   The tag **must** match `package.json` `version` (release.yml checks this) and
   point at a commit contained in protected `main` (release.yml checks this too
   — an unmerged commit is refused).
5. Pushing `v*` triggers **`release.yml`**, which pauses at the `release`
   environment approval gate. A reviewer approves the deployment, then it runs
   `npm publish --provenance`.
6. **dist-tag is automatic** from the version shape:
   - stable (no hyphen, e.g. `1.0.1`) → published to **`latest`**;
   - prerelease (a hyphen, e.g. `1.1.0-alpha.0`) → published to **`alpha`**,
     and `latest` is left untouched (a stable already exists).

## 4. Fixing a dist-tag after the fact

Use the **`promote-dist-tag`** workflow (Actions → Run workflow). It moves a
dist-tag (e.g. `latest`) onto an already-published version from CI, gated by the
same `release` environment — no local `npm login` needed. It refuses to point a
tag at a version that was never published.

## 5. Versioning scheme

Semver. Prereleases use `-alpha.N`. Patch = fixes (incl. behavior fixes for
consumers, like a bundling fix); minor = additive API; major = breaking changes.
