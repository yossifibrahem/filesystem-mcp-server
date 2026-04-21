import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";

// ─── Server Setup ────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "filesystem-mcp-server",
  version: "1.0.0",
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve and ensure path is absolute, expanding ~/ to the home directory */
function resolvePath(filePath: string): string {
  const expanded = filePath.startsWith("~/")
    ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", filePath.slice(2))
    : filePath;
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

/** Read directory listing up to 2 levels deep */
function listDirectory(dirPath: string, depth = 0, maxDepth = 2): string {
  if (depth > maxDepth) return "";
  const indent = "  ".repeat(depth);
  let output = "";
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    output += `${indent}${entry.isDirectory() ? "📁" : "📄"} ${entry.name}\n`;
    if (entry.isDirectory() && depth < maxDepth) {
      output += listDirectory(path.join(dirPath, entry.name), depth + 1, maxDepth);
    }
  }
  return output;
}

/** Format file lines with line numbers */
function formatWithLineNumbers(content: string, startLine?: number, endLine?: number): string {
  const lines = content.split("\n");
  const start = (startLine ?? 1) - 1;
  const end = endLine !== undefined ? endLine : lines.length;
  const slice = lines.slice(start, end);
  return slice
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join("\n");
}

// ─── Tool: files_write ───────────────────────────────────────────────────────

server.registerTool(
  "files_write",
  {
    title: "Write File",
    description: `Create or overwrite a file with the given content. Missing parent directories are created automatically.

Args:
  - path: File to write to (absolute, relative, or ~/path).
  - content: Full file content.

Returns the resolved path and byte count, or an error if the write failed.
For partial updates use files_edit.

Examples:
  - path="src/index.ts", content="console.log('hello')"
  - path="~/project/config.json", content="{}"`,
    inputSchema: {
      path: z
        .string()
        .min(1, "Path must not be empty")
        .describe("Absolute path, relative path, or ~/path to write to"),
      content: z
        .string()
        .describe("Full content to write into the file"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path: filePath, content }) => {
    try {
      const resolved = resolvePath(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, "utf8");

      const bytes = Buffer.byteLength(content, "utf8");
      return {
        content: [{ type: "text" as const, text: `✅ File written: ${resolved} (${bytes} bytes)` }],
        structuredContent: { path: resolved, bytes },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error writing file: ${message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: files_edit ────────────────────────────────────────────────────────

server.registerTool(
  "files_edit",
  {
    title: "Edit File (Find & Replace)",
    description: `Find and replace a unique substring in an existing file. old_str must match the file contents exactly and appear exactly once. Omit new_str to delete the match.

Args:
  - path: File to edit (absolute, relative, or ~/path).
  - old_str: Exact substring to find (must appear exactly once).
  - new_str: Replacement text (default: "" to delete).

Returns the resolved path and line number of the edit, or an error if not found, ambiguous, or file missing.
For new files use files_write.

Examples:
  - old_str="fucntion", new_str="function"
  - old_str="console.log('debug')\n", new_str="" (deletion)`,
    inputSchema: {
      path: z
        .string()
        .min(1, "Path must not be empty")
        .describe("Absolute path, relative path, or ~/path to edit"),
      old_str: z
        .string()
        .min(1, "old_str must not be empty")
        .describe("Exact substring to find (must appear exactly once)"),
      new_str: z
        .string()
        .default("")
        .describe("Replacement text; leave empty to delete the matched substring"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path: filePath, old_str, new_str }) => {
    try {
      const resolved = resolvePath(filePath);

      if (!fs.existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: `Error: File not found: ${resolved}` }],
          isError: true,
        };
      }

      const original = fs.readFileSync(resolved, "utf8");

      // Count occurrences
      const occurrences = original.split(old_str).length - 1;
      if (occurrences === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: String not found in ${resolved}` }],
          isError: true,
        };
      }
      if (occurrences > 1) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: String appears ${occurrences} times in ${resolved}. Add more context to make it unique.`,
            },
          ],
          isError: true,
        };
      }

      const updated = original.replace(old_str, new_str ?? "");
      fs.writeFileSync(resolved, updated, "utf8");

      // Report which line the change landed on
      const linesBefore = original.slice(0, original.indexOf(old_str)).split("\n").length;
      const linesAdded = (new_str ?? "").split("\n").length;

      return {
        content: [{ type: "text" as const, text: `✅ Edit applied at line ${linesBefore} in ${resolved} (+${linesAdded} lines)` }],
        structuredContent: { path: resolved, line: linesBefore, linesAdded },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error editing file: ${message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: files_read ────────────────────────────────────────────────────────

server.registerTool(
  "files_read",
  {
    title: "Read Path (File or Directory)",
    description: `Read a file or list a directory tree (2 levels deep, including hidden files).

Args:
  - path: File or directory to read (absolute, relative, or ~/path).
  - view_range: Optional [start_line, end_line] slice for text files. Use -1 for end of file. Ignored for directories.

Returns numbered line content for text files, an image content block for images (jpg/png/gif/webp), or a tree listing for directories.
Large text files (>16 000 chars) are mid-truncated with an omission notice — use view_range to reach hidden lines.
Non-UTF-8 bytes are shown as hex escapes (e.g. \x84).

Examples:
  - path="src/index.ts", view_range=[1, 50]
  - path="~/project" (directory listing)`,
    inputSchema: {
      path: z
        .string()
        .min(1, "Path must not be empty")
        .describe("Absolute path, relative path, or ~/path to a file or directory"),
      view_range: z
        .tuple([z.number().int(), z.number().int()])
        .optional()
        .describe(
          "Optional [start_line, end_line] range (1-indexed). Use -1 for end_line to read to EOF."
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path: filePath, view_range }) => {
    try {
      const resolved = resolvePath(filePath);

      if (!fs.existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: `Error: Path not found: ${resolved}` }],
          isError: true,
        };
      }

      const stat = fs.statSync(resolved);

      // Directory listing
      if (stat.isDirectory()) {
        const listing = listDirectory(resolved);
        return {
          content: [
            {
              type: "text" as const,
              text: `📁 Directory: ${resolved}\n\n${listing || "(empty directory)"}`,
            },
          ],
          structuredContent: { type: "directory", path: resolved },
        };
      }

      // Image files
      const ext = path.extname(resolved).toLowerCase();
      const imageTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
      };

      if (imageTypes[ext]) {
        const data = fs.readFileSync(resolved);
        const b64 = data.toString("base64");
        return {
          content: [
            {
              type: "image" as const,
              data: b64,
              mimeType: imageTypes[ext],
            },
          ],
          structuredContent: { type: "image", path: resolved, mimeType: imageTypes[ext] },
        };
      }

      // Text files
      const CHAR_LIMIT = 16000;
      const rawBuffer = fs.readFileSync(resolved);
      const rawContent = Array.from(rawBuffer).map((byte: number) => {
        if (byte < 0x80) return String.fromCharCode(byte);
        const char = Buffer.from([byte]).toString("utf8");
        return char === "\uFFFD" ? "\\x" + byte.toString(16).padStart(2, "0") : char;
      }).join("");
      const totalLines = rawContent.split("\n").length;
      let startLine: number | undefined;
      let endLine: number | undefined;

      if (view_range) {
        startLine = view_range[0];
        endLine = view_range[1] === -1 ? totalLines : view_range[1];
      }

      const sliced = startLine || endLine
        ? formatWithLineNumbers(rawContent, startLine, endLine)
        : null;

      // Apply mid-truncation when no range is specified and content is large
      let numbered: string;
      let truncated = false;
      if (sliced !== null) {
        numbered = sliced;
      } else if (rawContent.length <= CHAR_LIMIT) {
        numbered = formatWithLineNumbers(rawContent);
      } else {
        const halfLimit = Math.floor(CHAR_LIMIT / 2);
        const headContent = rawContent.slice(0, halfLimit);
        const tailContent = rawContent.slice(-halfLimit);
        const headLines = headContent.split("\n").length;
        const tailStartLine = totalLines - tailContent.split("\n").length + 1;
        numbered =
          formatWithLineNumbers(rawContent, 1, headLines) +
          `\n\n... [${totalLines - headLines - (totalLines - tailStartLine + 1)} lines omitted — use view_range to read them] ...\n\n` +
          formatWithLineNumbers(rawContent, tailStartLine, totalLines);
        truncated = true;
      }

      const rangeNote =
        startLine && endLine
          ? ` (lines ${startLine}–${endLine} of ${totalLines})`
          : truncated
          ? ` (${totalLines} lines, truncated — middle omitted)`
          : ` (${totalLines} lines)`;

      return {
        content: [
          {
            type: "text" as const,
            text: `📄 File: ${resolved}${rangeNote}\n\n${numbered}`,
          },
        ],
        structuredContent: {
          type: "file",
          path: resolved,
          totalLines,
          truncated,
          startLine: startLine ?? 1,
          endLine: endLine ?? totalLines,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error reading path: ${message}` }],
        isError: true,
      };
    }
  }
);

// ─── Transport ───────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("filesystem-mcp-server running on stdio");
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, () => {
    console.error(`filesystem-mcp-server running on http://localhost:${port}/mcp`);
  });
}

const transport = process.env.TRANSPORT ?? "stdio";
if (transport === "http") {
  runHTTP().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}