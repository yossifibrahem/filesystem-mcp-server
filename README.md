# filesystem-mcp-server

An MCP (Model Context Protocol) server that exposes three core filesystem tools under a consistent `filesystem_` prefix.

## Tools

### `filesystem_write_file`
Create or fully overwrite a file.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | Absolute or relative path to write to |
| `content` | string | ✅ | Full file content |
| `description` | string | ❌ | Optional reason for creating the file |

---

### `filesystem_edit_file`
Replace a unique substring within an existing file (find & replace).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | Path to the file to edit |
| `old_str` | string | ✅ | Exact substring to find (must appear exactly once) |
| `new_str` | string | ❌ | Replacement text (defaults to `""` for deletion) |
| `description` | string | ❌ | Optional reason for the edit |

---

### `filesystem_read_path`
Read a file with line numbers, or list a directory tree up to 2 levels deep.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | Absolute or relative path to a file or directory |
| `view_range` | [int, int] | ❌ | `[start_line, end_line]` slice of a text file. Use `-1` for end of file. |

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

## Claude Desktop Config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/filesystem-mcp-server/dist/index.js"]
    }
  }
}
```
