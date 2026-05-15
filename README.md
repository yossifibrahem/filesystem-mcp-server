# filesystem-mcp-server

An MCP (Model Context Protocol) server that exposes three core filesystem tools to any MCP-compatible AI client (Claude Desktop, Claude Code, Cursor, etc.).

An exact replica of the `create_file`, `str_replace`, and `view` tools built into Claude — same tool names, same parameters, same output format.

Supports **stdio** (local) and **HTTP** (remote/multi-client) transports.

---

## Tools

### `create_file`

Create a new file with content. Fails if the file already exists. Missing parent directories are created automatically.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `description` | string | ✅ | Why you're creating this file (**provide first**) |
| `path` | string | ✅ | Absolute or relative path to write to (**provide second**) |
| `file_text` | string | ✅ | Full file content (**provide last**) |

---

### `str_replace`

Replace a unique substring within an existing file (find & replace).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `description` | string | ✅ | Why you're making this edit |
| `path` | string | ✅ | Path to the file to edit |
| `old_str` | string | ✅ | Exact substring to find (must appear exactly once) |
| `new_str` | string | ❌ | Replacement text (defaults to `""` — omit to delete) |

---

### `view`

Read a file with line numbers, or list a directory tree up to 2 levels deep. Also renders images inline for supported clients.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `description` | string | ✅ | Why you need to view this path |
| `path` | string | ✅ | Absolute or relative path to a file or directory |
| `view_range` | [int, int] | ❌ | `[start_line, end_line]` slice of a text file. Use `-1` for end of file. |

Supported image types: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`

---

## Requirements

- **Node.js 18+**

---

## Installation

```bash
unzip filesystem-mcp-server-main.zip
cd filesystem-mcp-server-main
npm install
npm run build   # compiles TypeScript → dist/
```

---

## Configuration

Add to your MCP client config. The path to `node` and the server's `dist/index.js` must be absolute.

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/filesystem-mcp-server-main/dist/index.js"],
    }
  }
}
```

Config file locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/filesystem-mcp-server-main/dist/index.js"],
      "type": "stdio",
    }
  }
}
```

---

## Running

### stdio (default — for Claude Desktop / local use)
```bash
npm run build
npm start
```

### HTTP (for remote / multi-client use)
```bash
TRANSPORT=http PORT=3000 npm start
# → POST http://localhost:3000/mcp
```

The `PORT` env var controls which port to listen on (default: `3000`).

---

## Development

```bash
npm run build   # compile TypeScript → dist/
npm start       # run the compiled server
```

Test with the MCP Inspector:
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```