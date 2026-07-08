# Handoff: Gemini Omni Flash Tool Added + Exec-Bit Regression Fixed

**Date**: 2026-07-08
**Session**: Wired `gemini_omni_video` into the MCP server; broke the bin, then fixed it
**Status**: Resolved — tool live, cost confirmed, prevention doc added

---

## What Was Accomplished

### 1. Added `gemini_omni_video` tool
Full pattern match against `bytedance_seedance_video` across all three files:

- **`src/types.ts`**: `GeminiOmniVideoSchema` (zod) — prompt, duration (4/6/8/10s),
  aspect_ratio (16:9/9:16), resolution (720p/1080p/4k), `image_urls` (≤7, guided gen),
  `video_list` (≤1, edit mode — `url`/`start`/`ends`, ≤10s span, ≤100MB/≤30s source),
  `audio_ids`/`character_ids` (≤3 each), `seed`. Two `.refine()` validators: the
  7-unit input quota (images 1 unit, videos 2 units, character_ids 1 unit) and the
  video_list clip-span rule. Added `"gemini-omni-video"` to the `api_type` union.
- **`src/kie-ai-client.ts`**: `generateGeminiOmniVideo()` — POSTs `/jobs/createTask`
  with `model: "gemini-omni-video"` (confirmed against docs.kie.ai/market/gemini-omni-video,
  since the OpenAPI spec page listed specs but no MCP tool existed yet). Routed into the
  same `/jobs/recordInfo` polling branch as Seedance/Veo/Kling (not a separate endpoint
  like Runway Aleph or Midjourney).
- **`src/index.ts`**: tool registration (full JSON schema, `gemini_omni_video` in the
  `video` category array), dispatch `case`, and `handleGeminiOmniVideo()` handler —
  detects edit mode (`video_list` present) vs. generate mode in the response message,
  same Zod-error → `formatError()` pattern as every other handler.

Source: `docs.kie.ai/market/gemini-omni-video` fetched live via WebFetch (2026-07-08) —
endpoint, model id, full parameter table, and quota formula all confirmed against the
actual docs page, not guessed. **No credit cost was published there** — flagged as
unverified in ContentKaki's `video-producer.md` pending a real test call.

Verified locally before commit: `npx tsc --noEmit` clean, `npm run build` succeeded,
`npx jest` — 45/45 existing tests still pass (no regression in Seedance/Veo/etc schemas).

**Commit**: `2021a94` on branch `fix/surface-task-creation-errors`, later merged to `main`.

---

### 2. The regression: `Permission denied` on npx launch

After merging to main and asking the creator to restart Claude Desktop to pick up the
new tool, the **entire Kie.ai MCP server failed to connect** — not just the new tool
missing, the whole server down.

**Root cause**: `tsc` (the build step) wrote `dist/index.js` as mode `100644`
(`-rw-r--r--`), stripping the executable bit that was on the previous build. The
package's `bin` entry (`package.json`: `"kie-ai-mcp-server": "dist/index.js"`) requires
`dist/index.js` to be directly executable — npx creates a symlink to it in
`.bin/` and *executes the symlink target directly*, it does not `node dist/index.js`
for you. Non-executable target → `sh: .../kie-ai-mcp-server: Permission denied`.

Confirmed by reproducing locally:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize", ...}' \
  | env KIE_AI_API_KEY=test npx -y github:ivaneecreator-web/kie-ai-mcp-server
# → sh: .../kie-ai-mcp-server: Permission denied
```

**Compounding factor**: npm's git-dependency cache (`~/.npm/_npx/<hash>/`) had already
pulled and cached the *previous* clone before the fix landed. Simply re-running
`npx -y github:...` after the fix reused the stale cached clone (a Jun-3 build,
pre-Gemini-Omni, 268KB vs the correct 280KB) rather than re-fetching main. Confirmed via
`grep -c gemini_omni <cached-dist>` returning `0`. Required a full
`rm -rf ~/.npm/_npx/*` + `npm cache clean --force` before the unpinned
`npx github:ivaneecreator-web/kie-ai-mcp-server` command would resolve to the fixed
commit.

### 3. Fix
```bash
chmod +x dist/index.js
git add -f dist/index.js   # dist/ is .gitignore'd but force-tracked historically
git commit -m "Fix: restore executable bit on dist/index.js"
git push origin main
```
Commit `1dfbfc8`. Verified post-fix: `git diff --summary` showed
`mode change 100644 => 100755 dist/index.js` — confirms this was purely a mode-bit
issue, not a content regression.

---

## Root-Cause Prevention (why this can recur)

`dist/` is `.gitignore`'d (checked: `cat .gitignore` shows `dist` — presumably to keep
`git status` clean for local dev builds) **but is force-committed anyway** so that
`npx github:...` — which does NOT run `npm run build`, it runs the repo as-is — has a
working `dist/` to execute. This is an inherently fragile setup: **any future
`git add -f dist/` after a plain `tsc` rebuild will silently ship whatever file mode
`tsc` happened to write**, and `tsc` does not preserve or set the execute bit on its
output. This bit it always to `644` on every fresh build.

**This WILL happen again** the next time someone runs `npm run build && git add -f dist/
&& git commit` without remembering the `chmod +x` step.

### Fix options considered (not yet decided/implemented)
1. **`postbuild` npm script**: add `"postbuild": "chmod +x dist/index.js"` to
   `package.json` scripts, so `npm run build` always leaves the bit correct locally.
   Lowest-effort, but still relies on the human running `npm run build` before commit
   (someone could `tsc` directly and skip it).
2. **Git pre-commit hook**: reject commits where `dist/index.js` lacks `+x`. More
   robust — catches the mistake at commit time regardless of build method.
3. **Stop force-committing `dist/`**: switch the `bin` entry to a thin shell/JS shim
   that runs `node dist/index.js` explicitly (sidesteps exec-bit requirement entirely
   since `node <file>` doesn't need `+x` on the target). Removes the whole failure class
   but is a bigger structural change to how `npx github:...` currently works for this repo.

**Recommendation for next person touching this**: do option 1 immediately (cheap, no
downside) and consider option 3 if this happens a second time despite the postbuild
hook (e.g. if someone bypasses `npm run build`).

---

## Verification Trail (for reproducing / trusting this fix)

```bash
# 1. Local build boots clean, tool present, executable
cd ~/dev/kie-ai-mcp-server
chmod +x dist/index.js
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | env KIE_AI_API_KEY=test node dist/index.js | grep gemini_omni_video
# → {"name":"gemini_omni_video" ...

# 2. After push + npm cache clear, the UNPINNED command (what Claude Desktop actually runs)
rm -rf ~/.npm/_npx/* && npm cache clean --force
npx -y github:ivaneecreator-web/kie-ai-mcp-server  # boots, no Permission denied
BIN=$(ls -d ~/.npm/_npx/*/node_modules/@felores/kie-ai-mcp-server/dist/index.js)
grep -c gemini_omni "$BIN"   # → 5 (present)
ls -l "$BIN"                 # → -rwxr-xr-x (executable)

# 3. Live end-to-end test (real credit spend, confirms cost)
# Generated AI7 (context-window-folding b-roll) for ContentKaki's Fable 5 script:
#   task_id 98355d67edbe262323a8bc3690b27f8f
#   6s / 720p / 9:16, creditsConsumed: 84, completed in 51s
#   Confirmed: Gemini Omni Flash is CHEAPER per-second than Seedance 2.0
#   (84cr/6s ≈ 14cr/s vs Seedance's 205cr/5s ≈ 41cr/s) — reverses the
#   ~50%-pricier third-party estimate used before this test.
```

---

## Files Changed

| File | Change |
|---|---|
| `src/types.ts` | +`GeminiOmniVideoSchema`, +`GeminiOmniVideoRequest` type, +`"gemini-omni-video"` to `api_type` union |
| `src/kie-ai-client.ts` | +import, +`generateGeminiOmniVideo()`, +`"gemini-omni-video"` to the `/jobs/recordInfo` polling branch |
| `src/index.ts` | +import, +tool registration (schema), +`"gemini_omni_video"` to `TOOL_CATEGORIES.video`, +dispatch case, +`handleGeminiOmniVideo()` |
| `dist/*` (compiled) | Rebuilt; `dist/index.js` mode fixed `100644` → `100755` in follow-up commit |

**Commits**: `2021a94` (feature) → `1dfbfc8` (exec-bit fix), both on `main`.

## Downstream Consumer

ContentKaki v2.1's `.claude/agents/video-producer.md` was updated in the same session:
router tables reference `gemini_omni_video` directly (no longer "manual recipe only"),
a dedicated note in Step 3-AUTO covers the `video_list` edit-path usage, and the
credit-cost flag was updated from "unverified, ~50% pricier estimate" to the confirmed
"84 credits for 6s/720p/9:16, cheaper per-second than Seedance 2.0" figure once the
live test completed.
