# Troubleshooting

## "Permission denied" when Claude Desktop / npx launches the server

**Symptom**: MCP server shows as disconnected in Claude Desktop / Claude Code, or
`npx github:ivaneecreator-web/kie-ai-mcp-server` fails immediately with:
```
sh: /Users/.../.npm/_npx/<hash>/node_modules/.bin/kie-ai-mcp-server: Permission denied
```

**Cause**: `dist/index.js` lost its executable bit (mode `644` instead of `755`).
The `bin` entry in `package.json` points npx at this file directly — npx creates
a symlink in `.bin/` and executes the **symlink target directly** (it does not run
`node dist/index.js` for you). If the target isn't `+x`, the shell refuses to run it.

This happens whenever `dist/` is rebuilt with `tsc` and re-committed: **`tsc` always
writes its output at mode `644`, never preserving or setting `+x`.** If you forget to
`chmod +x` before committing, this WILL break every downstream consumer on their next
`npx` pull, because `dist/` is intentionally force-committed (`git add -f dist/`,
despite `dist/` being `.gitignore`'d for local dev cleanliness) so that
`npx github:...` has something to execute without running a build step itself.

**Fix**:
```bash
chmod +x dist/index.js
git add -f dist/index.js
git commit -m "Fix: restore executable bit on dist/index.js"
git push origin main
```

**Verify the fix actually shipped** (don't just trust the commit — npm's git-dependency
cache can serve a stale clone even after you've pushed the fix):
```bash
# Clear BOTH caches — npx's per-repo cache AND npm's underlying git cache
rm -rf ~/.npm/_npx/*
npm cache clean --force

# Re-pull with the EXACT unpinned command your MCP client config uses
npx -y github:ivaneecreator-web/kie-ai-mcp-server

# Confirm the pulled copy is executable and current
BIN=$(ls -d ~/.npm/_npx/*/node_modules/@felores/kie-ai-mcp-server/dist/index.js)
ls -l "$BIN"              # must show -rwxr-xr-x
grep -c <new-tool-name> "$BIN"   # must be > 0 if you were also shipping a new tool
```
If the re-pull still shows a stale/non-executable file after clearing both caches,
check `git ls-remote origin main` matches the commit you expect — you may be looking
at an unpushed local commit, or the client config may be pinned to a different ref/tag.

**Prevention** (not yet implemented — do this next time you touch the build):
1. Add to `package.json`: `"scripts": {"postbuild": "chmod +x dist/index.js"}` so
   `npm run build` always leaves the bit correct. Cheapest fix, but relies on people
   running `npm run build` (not raw `tsc`) before committing.
2. Stronger: a pre-commit hook that rejects a commit if `dist/index.js` lacks `+x`.
3. Structural: change `bin` to point at a thin wrapper (`bin/run.js` with
   `#!/usr/bin/env node` that `require()`s `dist/index.js`) so the executed file is
   small, hand-maintained, and never touched by `tsc` — removes the failure class
   entirely at the cost of one extra indirection file.

See `history/2026-07-08-215000_gemini-omni-video-and-exec-bit-fix.md` for the full
incident writeup (this exact bug, root-caused and fixed while adding the
`gemini_omni_video` tool).
