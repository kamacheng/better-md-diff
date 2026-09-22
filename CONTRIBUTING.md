# Contributing / 参与开发

欢迎报告问题和提交小范围改进。请勿在 issue、测试或演示中附带真实笔记、访问令牌或个人配置。

## Development

Use Node.js 22.12+ (22.x) or 24+, npm, and a local Git installation:

```bash
npm ci
npm run check
npm run dev
```

`npm run check` runs the official Obsidian ESLint recommended rules with zero warnings, tests, strict TypeScript checking, build, and release validation. Install dependencies **before** linting: missing Obsidian, CodeMirror, Node or diff declarations can produce hundreds of misleading `no-unsafe-*` diagnostics.

When changing dependencies with npm 11, also run `npx npm@10 install --package-lock-only --ignore-scripts` and verify `npx npm@10 ci` as well as `npm ci`: npm 11 can omit a nested esbuild lock entry that npm 10 requires. Do not hand-edit that entry.

The ESLint plugin's old Obsidian peer/dependency requirement is overridden to the project's pinned SDK version. This keeps one set of host declarations and allows plain `npm ci`; do not use `--force` or disable the type-safety rules to silence diagnostics. Brand/acronym allowances preserve `Better MD Diff`, `Markdown`, `Git`, `HEAD` and `PATH`; they do not change the Chinese UI.

## Changes and testing

- Keep Git operations read-only. Never introduce staging, reset, checkout, commit, push, or implicit file writes.
- Per-change restoration must retain confirmation, cancellation, fresh HEAD/buffer validation, and a single undoable editor transaction. Display context must never expand its scope.
- Add regression tests at public interfaces. Tests use temporary Git repositories and may mock the Obsidian runtime boundary (the npm SDK provides declarations, not a host).
- Use an isolated test vault for real Obsidian checks. Test source mode, Live Preview, popout windows, copy, restore, cancel and undo; disable unrelated formatting plugins.
- `getSettingDefinitions()` supports Obsidian 1.13+ settings search. Keep the `display()` fallback for 1.8–1.12; both use the same definitions.
- Do not commit `node_modules`, built bundles, personal configuration, recordings of private notes, or temporary test vaults.

## Release and attestations

1. Update `package.json`, the lockfile (including its root package entry), `manifest.json` and `versions.json` to a **new** version. Do not move or reuse an existing release tag.
2. Run `npm ci && npm run check` and complete the isolated-vault checks.
3. Review and commit the changes. Push a tag that exactly matches the manifest version, without `v` (for example `0.2.1` when preparing that version).
4. `.github/workflows/release.yml` builds from the tag, signs the three release assets with GitHub artifact attestations, and creates a **draft** release. It never publishes automatically.
5. Review the workflow, draft and assets; then publish the draft manually. Do not replace an asset with a locally rebuilt file after signing. If a draft already exists, the workflow fails rather than overwriting it; inspect and resolve it manually before retrying.
6. Check the community scorecard after it scans the new release. Local fixes do not alter the scorecard of an older release.

A downloaded asset can be verified with GitHub CLI:

```bash
gh attestation verify main.js --repo kamacheng/better-md-diff
gh attestation verify styles.css --repo kamacheng/better-md-diff
```

Attestations prove build provenance, not absence of vulnerabilities. The signing step requires GitHub Actions OIDC and cannot be meaningfully verified by a local build alone. See [community review notes](docs/community-review.md) for residual disclosures.
