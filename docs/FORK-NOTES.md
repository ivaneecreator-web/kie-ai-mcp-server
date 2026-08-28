# Fork notes — `ivaneecreator-web/kie-ai-mcp-server`

This repository is a fork of [`felores/kie-cli-mcp`](https://github.com/felores/kie-cli-mcp).
It tracks upstream closely. Everything below is the deliberate divergence, and nothing else
should diverge.

## Why the fork exists

ContentKaki ships this MCP server to non-technical buyers with a single command:

```
npx -y github:ivaneecreator-web/kie-ai-mcp-server
```

Upstream publishes to a package registry, so its monorepo root (`kie-ai-monorepo`) has no
`bin` entry and nothing to run. Installed straight from git, `npx` fails with
"could not determine executable to run". The fork closes that gap.

## The divergence

1. **Root `bin` entry** in `package.json`:
   `"kie-ai-mcp-server": "packages/mcp/dist/index.js"`.
   This is the only functional change to upstream's root manifest.

2. **A committed launch bundle** at `packages/mcp/dist/index.js` — the esbuild single-file
   output, with `@felores/kie-ai-core` inlined. Upstream never tracks `dist/`; the fork must,
   because a git install has no build step and buyers must not need one. `.gitignore` carries
   a matching negation rule.

3. **`npm run fork:bundle`** rebuilds that bundle and restores its executable bit.

4. **No `release.yml`.** Upstream's npm-publish workflow is deleted here. The fork ships from
   git (`npx -y github:...`), never from a registry, so the workflow could only ever misfire:
   it triggers on any `v*` tag, and a clone that has fetched upstream carries ~48 of those.
   It would fail on the missing npm token rather than publish anything under the `@felores`
   scope, but there is no reason to keep a trigger that can only produce red builds.

5. **Docs**: this file, `docs/TROUBLESHOOTING.md`, and the `history/` incident writeup.

## Syncing with upstream

```bash
git fetch upstream
git merge upstream/main
npm install
npm run fork:bundle
git add -f packages/mcp/dist/index.js
```

Then verify the buyer path actually works before pushing:

```bash
npx -y "git+file://$PWD#<your-branch>" --help
```

**The bundle is a build artifact under version control.** It goes stale the moment upstream
changes any source file, so `npm run fork:bundle` is not optional on a sync — a merge that
skips it ships buyers the previous release's server.

The executable bit on the bundle has been lost before by a rebuild that force-committed
`dist/`; that breaks every launch with `Permission denied`. `fork:bundle` chmods it, and
`git ls-files -s packages/mcp/dist/index.js` must report mode `100755`. See
`docs/TROUBLESHOOTING.md`.

## Patches retired at the 5.1.0 sync

Both fork-local code changes were superseded by upstream and deleted rather than merged:

- `gemini_omni_video` — upstream's `gemini_omni` is a superset (the same video generation and
  `video_list` edit mode, plus `character` and `audio` operations). Note the **tool rename**:
  callers that allow-listed `gemini_omni_video` need `gemini_omni`.
- Task-creation error surfacing across six handlers (`nano_banana_image`,
  `veo3_generate_video`, `kling_video`, `hailuo_video`, `flux2_image`, `wan_animate`) —
  upstream now throws on a non-200 response in all six.
