import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Expand ~/ to the user's home directory, matching shell behaviour on the host machine. */
function resolvePath(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "filesystem-mcp-server",
  version: "1.1.0",
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const IGNORED = new Set(["node_modules"]);

function humanSize(bytes: number): string {
  if (bytes >= 1_073_741_824) return (bytes / 1_073_741_824).toFixed(1) + "G";
  if (bytes >= 1_048_576)     return (bytes / 1_048_576).toFixed(1) + "M";
  if (bytes >= 1_024)         return Math.round(bytes / 1_024) + "K";
  return bytes + "B";
}

/**
 * Recursive directory listing up to 2 levels deep.
 * Output format matches Claude's `view` tool exactly:
 *   <size>\t<absolute-path>
 * Hidden entries (starting with ".") and node_modules are skipped.
 */
function listDirectory(dirPath: string, depth = 0): string {
  if (depth >= 2) return "";
  let output = "";
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      output += `${humanSize(stat.size)}\t${fullPath}\n`;
      if (entry.isDirectory() && depth < 1) {
        output += listDirectory(fullPath, depth + 1);
      }
    } catch {
      // skip unreadable entries
    }
  }
  return output;
}

/** Format a slice of lines with padded 1-based line numbers — matches Claude's view output exactly. */
function formatWithLineNumbers(lines: string[], startIdx: number, endIdx: number): string {
  return lines
    .slice(startIdx, endIdx)
    .map((line, i) => `${String(startIdx + i + 1).padStart(6)}\t${line}`)
    .join("\n");
}

/**
 * Decode a Buffer to a string, replacing invalid UTF-8 bytes with \xNN hex escapes.
 *
 * Properly handles multi-byte UTF-8 sequences:
 *   valid sequences    → rendered as-is
 *   invalid bytes      → \xNN  (lowercase hex, zero-padded to 2 digits)
 *
 * Handles:
 *   - Orphaned continuation bytes (0x80–0xBF without a leading byte)
 *   - Invalid leading bytes (0xF8–0xFF)
 *   - Truncated sequences (leading byte but not enough continuation bytes)
 *   - Overlong/surrogate encodings (Node decodes them as U+FFFD)
 *
 * This matches Claude's `view` tool output exactly.
 */
function decodeUtf8WithHexEscapes(buffer: Buffer): string {
  let result = "";
  let i = 0;

  while (i < buffer.length) {
    const b0 = buffer[i];

    // ASCII (single byte, bit 7 = 0)
    if ((b0 & 0x80) === 0) {
      result += String.fromCharCode(b0);
      i++;
      continue;
    }

    // Determine expected multi-byte sequence length from leading byte
    let seqLen: number;
    if      ((b0 & 0xE0) === 0xC0) { seqLen = 2; }
    else if ((b0 & 0xF0) === 0xE0) { seqLen = 3; }
    else if ((b0 & 0xF8) === 0xF0) { seqLen = 4; }
    else {
      // Orphaned continuation byte (0x80–0xBF) or out-of-range byte (0xF8–0xFF)
      result += "\\x" + b0.toString(16).padStart(2, "0");
      i++;
      continue;
    }

    // Truncated sequence (not enough bytes remaining in buffer)
    if (i + seqLen > buffer.length) {
      result += "\\x" + b0.toString(16).padStart(2, "0");
      i++;
      continue;
    }

    // All continuation bytes must match 0x80–0xBF (top two bits = 10)
    let valid = true;
    for (let j = 1; j < seqLen; j++) {
      if ((buffer[i + j] & 0xC0) !== 0x80) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      result += "\\x" + b0.toString(16).padStart(2, "0");
      i++;
      continue;
    }

    // Decode the complete sequence
    const decoded = buffer.subarray(i, i + seqLen).toString("utf8");

    // Node still emits U+FFFD for overlong encodings or surrogate code points
    if (decoded.includes("\uFFFD")) {
      result += "\\x" + b0.toString(16).padStart(2, "0");
      i++;
    } else {
      result += decoded;
      i += seqLen;
    }
  }

  return result;
}

// ─── Tool: create_file ────────────────────────────────────────────────────────

server.registerTool(
  "create_file",
  {
    title: "Create File",
    description:
      "Create a new file with content in the container. Missing parent directories are created automatically.",
    inputSchema: {
      description: z
        .string()
        .describe("Why you're creating this file. ALWAYS PROVIDE THIS PARAMETER FIRST."),
      path: z
        .string()
        .describe("Path to the file to create. ALWAYS PROVIDE THIS PARAMETER SECOND."),
      file_text: z
        .string()
        .describe("Content to write to the file. ALWAYS PROVIDE THIS PARAMETER LAST."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path: rawPath, file_text }) => {
    const filePath = resolvePath(rawPath);

    try {
      if (fs.existsSync(filePath)) {
        return {
          content: [{ type: "text" as const, text: `File already exists: ${filePath}` }],
          isError: true,
        };
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file_text, "utf8");

      return {
        content: [{ type: "text" as const, text: `File created successfully: ${filePath}` }],
        structuredContent: { path: filePath },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error creating file: ${message}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: str_replace ────────────────────────────────────────────────────────

server.registerTool(
  "str_replace",
  {
    title: "Edit File (str_replace)",
    description:
      "Replace a unique string in a file with another string. old_str must match the raw file content exactly and appear exactly once. When copying from view output, do NOT include the line number prefix (spaces + line number + tab) — it is display-only. View the file immediately before editing; after any successful str_replace, earlier view output of that file in your context is stale — re-view before further edits to the same file.",
    inputSchema: {
      description: z
        .string()
        .describe("Why I'm making this edit"),
      path: z
        .string()
        .describe("Path to the file to edit"),
      old_str: z
        .string()
        .describe("String to replace (must be unique in file)"),
      new_str: z
        .string()
        .default("")
        .describe("String to replace with (empty to delete)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path: rawPath, old_str, new_str }) => {
    const filePath = resolvePath(rawPath);

    if (!fs.existsSync(filePath)) {
      return {
        content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
        isError: true,
      };
    }

    try {
      const original = fs.readFileSync(filePath, "utf8");
      const occurrences = original.split(old_str).length - 1;

      if (occurrences === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `String to replace not found in ${filePath}. Use the view tool to see the current file content before retrying. If you made a successful str_replace to this file since your last view, that edit invalidated your view output.`,
            },
          ],
          isError: true,
        };
      }

      if (occurrences > 1) {
        return {
          content: [
            {
              type: "text" as const,
              text: `String to replace found multiple times, must be unique`,
            },
          ],
          isError: true,
        };
      }

      // Exactly one occurrence — use a replacer function to avoid special `$` patterns
      // in new_str being interpreted by String.prototype.replace's replacement syntax.
      const updated = original.replace(old_str, () => new_str ?? "");
      fs.writeFileSync(filePath, updated, "utf8");

      return {
        content: [{ type: "text" as const, text: `Successfully replaced string in ${filePath}` }],
        structuredContent: { path: filePath },
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

// ─── Tool: view ───────────────────────────────────────────────────────────────

server.registerTool(
  "view",
  {
    title: "View Path (File or Directory)",
    description:
      "Supports viewing text, images, and directory listings.\n\n" +
      "Supported path types:\n" +
      "- Directories: Lists files and directories up to 2 levels deep, ignoring hidden items and node_modules\n" +
      "- Image files (.jpg, .jpeg, .png, .gif, .webp): Displays the image visually\n" +
      "- Text files: Displays numbered lines (prefix `    N\\t` is display-only — do not include it in str_replace's `old_str`). You can optionally specify a view_range to see specific lines.\n\n" +
      "Note: Files with non-UTF-8 encoding will display hex escapes (e.g. \\x84) for invalid bytes",
    inputSchema: {
      description: z
        .string()
        .describe("Why I need to view this"),
      path: z
        .string()
        .describe("Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`."),
      view_range: z
        .tuple([z.number().int(), z.number().int()])
        .optional()
        .describe(
          "Optional [start_line, end_line] where lines are indexed starting at 1. Use [start_line, -1] to view from start_line to the end of the file. When not provided, the entire file is displayed, truncating from the middle if it exceeds 16,000 characters (showing beginning and end)."
        ),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path: rawPath, view_range }) => {
    const filePath = resolvePath(rawPath);

    if (!fs.existsSync(filePath)) {
      return {
        content: [{ type: "text" as const, text: `Path not found: ${filePath}` }],
        isError: true,
      };
    }

    try {
      const stat = fs.statSync(filePath);

      // ── Directory ──────────────────────────────────────────────────────────
      if (stat.isDirectory()) {
        let listing = `${humanSize(stat.size)}\t${filePath}\n`;
        listing += listDirectory(filePath);
        return {
          content: [{ type: "text" as const, text: listing.trimEnd() }],
          structuredContent: { type: "directory", path: filePath },
        };
      }

      // ── Image ──────────────────────────────────────────────────────────────
      const ext = path.extname(filePath).toLowerCase();
      const imageTypes: Record<string, string> = {
        ".jpg":  "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png":  "image/png",
        ".gif":  "image/gif",
        ".webp": "image/webp",
      };
      if (imageTypes[ext]) {
        const data = fs.readFileSync(filePath);
        return {
          content: [
            {
              type: "image" as const,
              data: data.toString("base64"),
              mimeType: imageTypes[ext],
            },
          ],
          structuredContent: { type: "image", path: filePath, mimeType: imageTypes[ext] },
        };
      }

      // ── Text file ──────────────────────────────────────────────────────────
      const rawBuffer = fs.readFileSync(filePath);
      const rawContent = decodeUtf8WithHexEscapes(rawBuffer);
      const lines = rawContent.split("\n");
      const totalLines = lines.length;

      // ── view_range path ────────────────────────────────────────────────────
      if (view_range) {
        const [startLine, endLineRaw] = view_range;

        // Validate: start must be ≥ 1
        // Exact error format from Claude's view tool:
        //   "Invalid `view_range`: First element `N` should be between 1 and M"
        if (startLine < 1) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid \`view_range\`: First element \`${startLine}\` should be between 1 and ${totalLines}`,
              },
            ],
            isError: true,
          };
        }

        // Resolve -1 sentinel to actual last line
        const endLine = endLineRaw === -1 ? totalLines : endLineRaw;

        // Validate: end must be ≥ start (after resolving -1)
        // Exact error format from Claude's view tool:
        //   "Invalid `view_range`: Second element `N` should be between M and T, or -1 for end of file"
        if (endLine < startLine) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid \`view_range\`: Second element \`${endLineRaw}\` should be between ${startLine} and ${totalLines}, or -1 for end of file`,
              },
            ],
            isError: true,
          };
        }

        // Clamp end to actual file length (beyond-EOF request → silently clamp)
        const clampedEnd = Math.min(endLine, totalLines);
        const numbered = formatWithLineNumbers(lines, startLine - 1, clampedEnd);

        return {
          content: [
            {
              type: "text" as const,
              // Exact format: numbered lines followed by "[N lines total]"
              text: `${numbered}\n[${totalLines} lines total]`,
            },
          ],
          structuredContent: {
            type: "file",
            path: filePath,
            totalLines,
            startLine,
            endLine: clampedEnd,
          },
        };
      }

      // ── Full file (no view_range) ──────────────────────────────────────────
      const CHAR_LIMIT = 16_000;

      if (rawContent.length <= CHAR_LIMIT) {
        const numbered = formatWithLineNumbers(lines, 0, totalLines);
        return {
          content: [{ type: "text" as const, text: numbered }],
          structuredContent: { type: "file", path: filePath, totalLines, truncated: false },
        };
      }

      // ── Mid-truncation for large files ─────────────────────────────────────
      // Shows beginning and end separated by a truncation notice in the middle.
      // The character budget is split equally between head and tail.
      const halfLimit = Math.floor(CHAR_LIMIT / 2);
      const headChars = rawContent.slice(0, halfLimit);
      const tailChars = rawContent.slice(-halfLimit);

      // Count complete lines represented in each half-window
      // When the 8000-char slice cuts mid-line (no trailing \n), the partial line
      // still belongs in the head — we display its full version from `lines[]`.
      // Only subtract 1 when the slice ends exactly on a newline (the trailing item
      // from split() would be an empty string representing the *start* of the next line).
      const headLineCount = headChars.split("\n").length - (headChars.endsWith("\n") ? 1 : 0);
      const tailLineStart = totalLines - tailChars.split("\n").length + 2;

      const headFormatted = formatWithLineNumbers(lines, 0, headLineCount);
      const tailFormatted = formatWithLineNumbers(lines, tailLineStart - 1, totalLines);

      const omittedStart = headLineCount + 1;
      const omittedEnd   = tailLineStart - 1;

      // Exact truncation notice format from Claude's view tool:
      //   \t< truncated lines N-M >
      const text =
        headFormatted +
        `\n\t< truncated lines ${omittedStart}-${omittedEnd} >\n` +
        tailFormatted;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          type: "file",
          path: filePath,
          totalLines,
          truncated: true,
          omittedStart,
          omittedEnd,
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

// ─── Transport ────────────────────────────────────────────────────────────────

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