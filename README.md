# filesystem-mcp-server

An MCP server that replicates Claude's built-in `view`, `str_replace`, and `create_file` tools — running on your **host machine** rather than an isolated container.

## Tools

### `view`
Read files, directories, or images.

- **Directory**: lists entries up to 2 levels deep; skips hidden files and `node_modules`
- **Image** (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`): returns base64 data
- **Text file**: returns numbered lines (`     N\t<content>`); truncates files over 16,000 characters by showing the head and tail with a `\t< truncated lines N-M >` notice in between
- **`view_range`**: `[start, end]` (1-based); use `-1` as end to read to EOF; beyond-EOF end is silently clamped
- **Non-UTF-8 bytes**: invalid bytes are rendered as `\xNN` hex escapes; valid multi-byte sequences pass through correctly
- **`~` expansion**: paths starting with `~/` resolve to the user's home directory

Error messages match Claude's tool output exactly:
```
Path not found: <path>
Invalid `view_range`: First element `N` should be between 1 and M
Invalid `view_range`: Second element `N` should be between M and T, or -1 for end of file
```

---

### `str_replace`
Replace a **unique** substring in a file.

- `old_str` must match exactly once — zero or multiple matches are both errors
- `new_str` defaults to `""` (omit to delete the matched string)
- Uses a replacer function internally so `$` characters in `new_str` are never misinterpreted
- Files are read and written as UTF-8

Error messages match Claude's tool output exactly:
```
File not found: <path>
String to replace not found in <path>. Use the view tool to see the current file content before retrying…
String to replace found multiple times, must be unique
```

---

### `create_file`
Create a new file (fails if it already exists).

- Parent directories are created automatically (`mkdirSync` with `{ recursive: true }`)
- `~` expansion supported in `path`

Error messages match Claude's tool output exactly:
```
File already exists: <path>
```

---

## Differences from Claude's in-container tools

| Aspect | Claude (container) | This server (host) |
|---|---|---|
| Filesystem scope | Sandboxed `/home/claude` | Full host filesystem |
| `~` expansion | Not needed (fixed paths) | Expands to `os.homedir()` |
| Image rendering | Inline in chat UI | base64 returned to client |

---

## Usage

### stdio (default — for Claude Desktop / Claude Code)

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["/path/to/filesystem-mcp-server/dist/index.js"]
    }
  }
}
```

### HTTP

```bash
TRANSPORT=http PORT=3000 node dist/index.js
# POST http://localhost:3000/mcp
```

---

## Build

```bash
npm install
npm run build   # tsc → dist/
npm start       # node dist/index.js
```