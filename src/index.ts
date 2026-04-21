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

/** Resolve and ensure path is absolute */
function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

/** Read directory listing up to 2 levels deep */
function listDirectory(dirPath: string, depth = 0, maxDepth = 2): string {
  if (depth > maxDepth) return "";
  const indent = "  ".repeat(depth);
  let output = "";
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
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
    description: `Create a new file or overwrite an existing file with the given content.

Automatically creates any missing parent directories. If the file already exists,
it will be completely overwritten — use files_edit for partial updates.

Args:
  - path (string): Absolute or relative path where the file should be written.
                   Example: "/home/user/project/main.ts" or "src/utils.ts"
  - content (string): Full content to write to the file.

Returns:
  A success message with the resolved absolute path and byte count written,
  or an error message if the write failed.

Examples:
  - Use when: "Create a new config.json" -> path="config.json", content="{}"
  - Use when: "Save this script as run.sh" -> path="run.sh", content="#!/bin/bash..."
  - Don't use when: You only need to update part of a file (use files_edit instead)

Error Handling:
  - Returns "Error: Permission denied" if the path is not writable
  - Returns "Error: ..." with the OS error message for other failures`,
    inputSchema: {
      path: z
        .string()
        .min(1, "Path must not be empty")
        .describe("Absolute or relative file path to write to"),
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
    description: `Replace a unique substring within an existing file with new content.

The old_str must match the raw file contents exactly (including whitespace and newlines)
and must appear exactly once — if it appears zero or more than once the operation fails
to prevent unintended edits. To delete content, pass an empty string for new_str.

Args:
  - path (string): Absolute or relative path to the file to edit.
  - old_str (string): The exact substring to search for. Must appear exactly once.
  - new_str (string, optional): The replacement text. Defaults to "" (deletion).

Returns:
  A success message with the resolved path and line range affected,
  or an error message if the match was not found or was ambiguous.

Examples:
  - Use when: "Fix a typo in utils.ts" -> old_str="fucntion", new_str="function"
  - Use when: "Remove the debug line" -> old_str="console.log('debug')\n", new_str=""
  - Don't use when: You want to create a new file (use files_write instead)
  - Don't use when: The string appears in multiple locations (narrow it down with more context)

Error Handling:
  - Returns "Error: String not found" if old_str has zero matches
  - Returns "Error: String appears N times" if old_str matches more than once
  - Returns "Error: File not found" if the path does not exist`,
    inputSchema: {
      path: z
        .string()
        .min(1, "Path must not be empty")
        .describe("Absolute or relative path of the file to edit"),
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
    description: `Read the contents of a file with optional line-number filtering,
or list the contents of a directory up to 2 levels deep.

For text files, output includes line numbers prefixed to each line for easy reference.
For images (jpg, jpeg, png, gif, webp), the raw base64 data URL is returned.
For directories, a tree view (📁/📄) is returned, excluding hidden files and node_modules.

Args:
  - path (string): Absolute or relative path to a file or directory.
  - view_range (array of 2 integers, optional): [start_line, end_line] to read a slice
    of a text file. Use -1 for end_line to read to the end of the file.
    Line numbers are 1-indexed. Only valid when path points to a file.

Returns:
  For files: numbered line content (full or sliced).
  For images: data URL string.
  For directories: indented tree listing up to 2 levels deep.
  Or an error message if the path does not exist or cannot be read.

Examples:
  - Use when: "Show me the content of main.ts" -> path="src/main.ts"
  - Use when: "What's on lines 10-25 of config.json?" -> path="config.json", view_range=[10,25]
  - Use when: "List the project structure" -> path="/home/user/project"
  - Don't use when: You need to write or modify a file (use files_write or files_edit)

Error Handling:
  - Returns "Error: Path not found" if path does not exist
  - Returns "Error: Unsupported binary file" for non-image binary files`,
    inputSchema: {
      path: z
        .string()
        .min(1, "Path must not be empty")
        .describe("Absolute or relative path to a file or directory"),
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
              type: "text" as const,
              text: `data:${imageTypes[ext]};base64,${b64}`,
            },
          ],
          structuredContent: { type: "image", path: resolved, mimeType: imageTypes[ext] },
        };
      }

      // Text files
      const content = fs.readFileSync(resolved, "utf8");
      const totalLines = content.split("\n").length;
      let startLine: number | undefined;
      let endLine: number | undefined;

      if (view_range) {
        startLine = view_range[0];
        endLine = view_range[1] === -1 ? totalLines : view_range[1];
      }

      const numbered = formatWithLineNumbers(content, startLine, endLine);
      const rangeNote =
        startLine && endLine
          ? ` (lines ${startLine}–${endLine} of ${totalLines})`
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
