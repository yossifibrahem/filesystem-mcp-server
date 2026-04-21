"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express_1 = __importDefault(require("express"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const zod_1 = require("zod");
// ─── Server Setup ────────────────────────────────────────────────────────────
const server = new mcp_js_1.McpServer({
    name: "filesystem-mcp-server",
    version: "1.0.0",
});
// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Resolve and ensure path is absolute, expanding ~/ to the home directory */
function resolvePath(filePath) {
    const expanded = filePath.startsWith("~/")
        ? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", filePath.slice(2))
        : filePath;
    return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}
/** Read directory listing up to 2 levels deep */
function listDirectory(dirPath, depth = 0, maxDepth = 2) {
    if (depth > maxDepth)
        return "";
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
function formatWithLineNumbers(content, startLine, endLine) {
    const lines = content.split("\n");
    const start = (startLine ?? 1) - 1;
    const end = endLine !== undefined ? endLine : lines.length;
    const slice = lines.slice(start, end);
    return slice
        .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
        .join("\n");
}
// ─── Tool: files_write ───────────────────────────────────────────────────────
server.registerTool("files_write", {
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
        path: zod_1.z
            .string()
            .min(1, "Path must not be empty")
            .describe("Absolute path, relative path, or ~/path to write to"),
        content: zod_1.z
            .string()
            .describe("Full content to write into the file"),
    },
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async ({ path: filePath, content }) => {
    try {
        const resolved = resolvePath(filePath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, "utf8");
        const bytes = Buffer.byteLength(content, "utf8");
        return {
            content: [{ type: "text", text: `✅ File written: ${resolved} (${bytes} bytes)` }],
            structuredContent: { path: resolved, bytes },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Error writing file: ${message}` }],
            isError: true,
        };
    }
});
// ─── Tool: files_edit ────────────────────────────────────────────────────────
server.registerTool("files_edit", {
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
        path: zod_1.z
            .string()
            .min(1, "Path must not be empty")
            .describe("Absolute path, relative path, or ~/path to edit"),
        old_str: zod_1.z
            .string()
            .min(1, "old_str must not be empty")
            .describe("Exact substring to find (must appear exactly once)"),
        new_str: zod_1.z
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
}, async ({ path: filePath, old_str, new_str }) => {
    try {
        const resolved = resolvePath(filePath);
        if (!fs.existsSync(resolved)) {
            return {
                content: [{ type: "text", text: `Error: File not found: ${resolved}` }],
                isError: true,
            };
        }
        const original = fs.readFileSync(resolved, "utf8");
        // Count occurrences
        const occurrences = original.split(old_str).length - 1;
        if (occurrences === 0) {
            return {
                content: [{ type: "text", text: `Error: String not found in ${resolved}` }],
                isError: true,
            };
        }
        if (occurrences > 1) {
            return {
                content: [
                    {
                        type: "text",
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
            content: [{ type: "text", text: `✅ Edit applied at line ${linesBefore} in ${resolved} (+${linesAdded} lines)` }],
            structuredContent: { path: resolved, line: linesBefore, linesAdded },
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Error editing file: ${message}` }],
            isError: true,
        };
    }
});
// ─── Tool: files_read ────────────────────────────────────────────────────────
server.registerTool("files_read", {
    title: "Read Path (File or Directory)",
    description: `Read the contents of a file with optional line-number filtering,
or list the contents of a directory up to 2 levels deep.

For text files, output includes line numbers prefixed to each line for easy reference.
Non-UTF-8 bytes are rendered as hex escapes (e.g. \x84) rather than erroring.
Large files (>16 000 chars) are automatically truncated in the middle — the beginning and
end are shown with an omission notice; use view_range to read the hidden section.
For images (jpg, jpeg, png, gif, webp), an image content block is returned for rendering.
For directories, a tree view (📁/📄) is returned, including hidden files and node_modules.

Args:
  - path (string): Absolute or relative path to a file or directory.
  - view_range (array of 2 integers, optional): [start_line, end_line] to read a slice
    of a text file. Use -1 for end_line to read to the end of the file.
    Line numbers are 1-indexed. Ignored when path points to a directory.

Returns:
  For text files: numbered line content (full, sliced, or mid-truncated).
  For images: a rendered image content block.
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
        path: zod_1.z
            .string()
            .min(1, "Path must not be empty")
            .describe("Absolute path, relative path, or ~/path to a file or directory"),
        view_range: zod_1.z
            .tuple([zod_1.z.number().int(), zod_1.z.number().int()])
            .optional()
            .describe("Optional [start_line, end_line] range (1-indexed). Use -1 for end_line to read to EOF."),
    },
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async ({ path: filePath, view_range }) => {
    try {
        const resolved = resolvePath(filePath);
        if (!fs.existsSync(resolved)) {
            return {
                content: [{ type: "text", text: `Error: Path not found: ${resolved}` }],
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
                        type: "text",
                        text: `📁 Directory: ${resolved}\n\n${listing || "(empty directory)"}`,
                    },
                ],
                structuredContent: { type: "directory", path: resolved },
            };
        }
        // Image files
        const ext = path.extname(resolved).toLowerCase();
        const imageTypes = {
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
                        type: "image",
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
        const rawContent = Array.from(rawBuffer).map((byte) => {
            if (byte < 0x80)
                return String.fromCharCode(byte);
            const char = Buffer.from([byte]).toString("utf8");
            return char === "\uFFFD" ? "\\x" + byte.toString(16).padStart(2, "0") : char;
        }).join("");
        const totalLines = rawContent.split("\n").length;
        let startLine;
        let endLine;
        if (view_range) {
            startLine = view_range[0];
            endLine = view_range[1] === -1 ? totalLines : view_range[1];
        }
        const sliced = startLine || endLine
            ? formatWithLineNumbers(rawContent, startLine, endLine)
            : null;
        // Apply mid-truncation when no range is specified and content is large
        let numbered;
        let truncated = false;
        if (sliced !== null) {
            numbered = sliced;
        }
        else if (rawContent.length <= CHAR_LIMIT) {
            numbered = formatWithLineNumbers(rawContent);
        }
        else {
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
        const rangeNote = startLine && endLine
            ? ` (lines ${startLine}–${endLine} of ${totalLines})`
            : truncated
                ? ` (${totalLines} lines, truncated — middle omitted)`
                : ` (${totalLines} lines)`;
        return {
            content: [
                {
                    type: "text",
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
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Error reading path: ${message}` }],
            isError: true,
        };
    }
});
// ─── Transport ───────────────────────────────────────────────────────────────
async function runStdio() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("filesystem-mcp-server running on stdio");
}
async function runHTTP() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.post("/mcp", async (req, res) => {
        const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
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
}
else {
    runStdio().catch((err) => {
        console.error("Server error:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map