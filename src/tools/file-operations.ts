import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AgentTool } from "../core/types.js";

const ROOT_WORKSPACE = process.cwd();

// Paths that are strictly forbidden from being written to or read by the agent
const PROTECTED_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.git(\/|$)/i,
  /id_rsa/i,
  /\.pem$/i,
  /\.key$/i,
];

/**
 * Resolves and verifies that a file path is safely confined within the workspace.
 * Prevents Directory Traversal attacks (e.g., ../../../etc/passwd).
 */
export function resolveSafePath(targetPath: string): string {
  const normalized = path.normalize(targetPath).trim();
  const absolutePath = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(ROOT_WORKSPACE, normalized);

  // Reject any path outside the workspace root. Using path.relative (instead of a
  // naive string prefix check) closes the sibling-prefix bypass where a path like
  // "/workspace-evil/x" would wrongly pass a startsWith("/workspace") test.
  const relativeFromRoot = path.relative(ROOT_WORKSPACE, absolutePath);
  if (
    relativeFromRoot &&
    (relativeFromRoot === ".." ||
      relativeFromRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeFromRoot))
  ) {
    throw new Error(
      `Access Denied: Path traversal detected. "${targetPath}" is outside the authorized workspace.`,
    );
  }

  for (const pattern of PROTECTED_PATTERNS) {
    if (
      pattern.test(relativeFromRoot) ||
      pattern.test(path.basename(absolutePath))
    ) {
      throw new Error(
        `Security Policy Violation: Access to protected file "${relativeFromRoot}" is restricted.`,
      );
    }
  }

  return absolutePath;
}

// -----------------------------------------------------------------------------
// 1. File Writer Tool
// -----------------------------------------------------------------------------
const fileWriterSchema = z.object({
  path: z
    .string()
    .describe(
      "Relative path of the file to create or write, e.g. 'src/utils/math.ts' or 'notes.txt'",
    ),
  content: z.string().describe("Text or code content to write to the file"),
  overwrite: z
    .boolean()
    .default(true)
    .describe("Whether to overwrite if file already exists"),
});

export const fileWriterTool: AgentTool<typeof fileWriterSchema> = {
  name: "file_writer",
  description:
    "Creates a new file or overwrites an existing file within the workspace with safety checks.",
  parameters: fileWriterSchema,
  execute: async ({ path: targetPath, content, overwrite }) => {
    try {
      const safePath = resolveSafePath(targetPath);

      if (!overwrite) {
        try {
          await fs.access(safePath);
          return {
            error: `File already exists at "${targetPath}". Set overwrite: true to replace it.`,
            success: false,
          };
        } catch {
          // File does not exist, proceed
        }
      }

      // Ensure parent directories exist
      await fs.mkdir(path.dirname(safePath), { recursive: true });

      await fs.writeFile(safePath, content, "utf-8");

      return {
        path: path.relative(ROOT_WORKSPACE, safePath),
        bytesWritten: Buffer.byteLength(content, "utf-8"),
        success: true,
      };
    } catch (err: any) {
      return {
        error: err.message,
        path: targetPath,
        success: false,
      };
    }
  },
};

// -----------------------------------------------------------------------------
// 2. File Reader Tool
// -----------------------------------------------------------------------------
const fileReaderSchema = z.object({
  path: z
    .string()
    .describe("Relative path of the file to read within the workspace"),
  maxLines: z.coerce.number().int().min(1).max(1000).default(300),
});

export const fileReaderTool: AgentTool<typeof fileReaderSchema> = {
  name: "file_reader",
  description: "Reads the content of an existing file within the workspace.",
  parameters: fileReaderSchema,
  execute: async ({ path: targetPath, maxLines }) => {
    try {
      const safePath = resolveSafePath(targetPath);
      const raw = await fs.readFile(safePath, "utf-8");
      const lines = raw.split("\n");
      const truncated = lines.length > maxLines;
      const content = truncated ? lines.slice(0, maxLines).join("\n") : raw;

      return {
        path: path.relative(ROOT_WORKSPACE, safePath),
        content,
        totalLines: lines.length,
        truncated,
      };
    } catch (err: any) {
      return {
        error: err.message,
        path: targetPath,
      };
    }
  },
};

// -----------------------------------------------------------------------------
// 3. Directory Lister Tool
// -----------------------------------------------------------------------------
const directoryListerSchema = z.object({
  path: z
    .string()
    .default(".")
    .describe("Relative directory path to inspect, e.g. '.' or 'src'"),
  maxDepth: z.coerce.number().int().min(1).max(3).default(1),
});

export const directoryListerTool: AgentTool<typeof directoryListerSchema> = {
  name: "directory_lister",
  description:
    "Lists files and subdirectories within a given workspace directory.",
  parameters: directoryListerSchema,
  execute: async ({ path: targetPath, maxDepth }) => {
    try {
      const safePath = resolveSafePath(targetPath);

      const IGNORED_DIRS = new Set([
        "node_modules",
        ".git",
        "dist",
        ".next",
        ".cache",
      ]);

      async function scanDir(
        currentDir: string,
        depth: number,
      ): Promise<any[]> {
        if (depth > maxDepth) return [];
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        const results = [];

        for (const entry of entries) {
          if (IGNORED_DIRS.has(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          const relPath = path.relative(ROOT_WORKSPACE, fullPath);

          if (entry.isDirectory()) {
            results.push({
              name: entry.name,
              path: relPath,
              type: "directory",
              children: await scanDir(fullPath, depth + 1),
            });
          } else {
            results.push({
              name: entry.name,
              path: relPath,
              type: "file",
            });
          }
        }
        return results;
      }

      const tree = await scanDir(safePath, 1);
      return {
        directory: path.relative(ROOT_WORKSPACE, safePath) || ".",
        entries: tree,
      };
    } catch (err: any) {
      return {
        error: err.message,
        directory: targetPath,
      };
    }
  },
};

// -----------------------------------------------------------------------------
// 4. File Editor Tool
// -----------------------------------------------------------------------------
const fileEditorSchema = z.object({
  path: z.string().describe("Relative path of the existing file to edit"),
  operation: z
    .enum(["replace", "insert", "delete", "append", "prepend"])
    .describe(
      "Edit to apply: 'replace' first matching text, 'insert' new text at a line, 'delete' lines, 'append'/'prepend' text at a file boundary",
    ),
  oldText: z
    .string()
    .optional()
    .describe("Exact existing text to find (required for 'replace')"),
  newText: z
    .string()
    .optional()
    .describe(
      "Replacement or inserted text (required for replace/insert/append/prepend; may be empty for 'replace' to delete the match)",
    ),
  line: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number (required for 'insert' and 'delete')"),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(1)
    .describe("Number of lines to remove for 'delete' (default 1)"),
  replaceAll: z
    .boolean()
    .default(false)
    .describe("Replace every occurrence for 'replace' (default: require a unique match)"),
});

export const fileEditorTool: AgentTool<typeof fileEditorSchema> = {
  name: "file_editor",
  description:
    "Edits an existing file in the workspace using precise replace, insert, delete, append, or prepend operations.",
  parameters: fileEditorSchema,
  execute: async ({
    path: targetPath,
    operation,
    oldText,
    newText,
    line,
    count,
    replaceAll,
  }) => {
    const fail = (error: string) => ({ error, path: targetPath, success: false });

    try {
      const safePath = resolveSafePath(targetPath);

      let raw: string;
      try {
        raw = await fs.readFile(safePath, "utf-8");
      } catch {
        return fail(
          `File not found at "${targetPath}". Use the file_writer tool to create it first.`,
        );
      }

      let updated = raw;
      let linesChanged = 0;

      if (operation === "replace") {
        if (!oldText) {
          return fail("'replace' requires a non-empty 'oldText'.");
        }
        if (typeof newText !== "string") {
          return fail(
            "'replace' requires 'newText' (use an empty string to delete the matched text).",
          );
        }

        const occurrences = raw.split(oldText).length - 1;
        if (occurrences === 0) {
          return fail(`Could not find 'oldText' in "${targetPath}".`);
        }
        if (occurrences > 1 && !replaceAll) {
          return fail(
            `'oldText' matched ${occurrences} times in "${targetPath}". Provide more surrounding context or set replaceAll: true.`,
          );
        }

        updated = replaceAll
          ? raw.split(oldText).join(newText)
          : raw.replace(oldText, newText);
        linesChanged = replaceAll ? occurrences : 1;
      } else if (operation === "insert") {
        if (typeof newText !== "string") {
          return fail("'insert' requires 'newText'.");
        }
        if (line === undefined) {
          return fail("'insert' requires a 1-based 'line'.");
        }

        const lines = raw.split("\n");
        if (line > lines.length + 1) {
          return fail(
            `Line ${line} is out of range: "${targetPath}" has ${lines.length} lines.`,
          );
        }

        const inserted = newText.split("\n");
        lines.splice(line - 1, 0, ...inserted);
        updated = lines.join("\n");
        linesChanged = inserted.length;
      } else if (operation === "delete") {
        if (line === undefined) {
          return fail("'delete' requires a 1-based 'line'.");
        }

        const lines = raw.split("\n");
        if (line > lines.length) {
          return fail(
            `Line ${line} is out of range: "${targetPath}" has ${lines.length} lines.`,
          );
        }

        const removed = lines.splice(line - 1, count);
        updated = lines.join("\n");
        linesChanged = removed.length;
      } else {
        if (typeof newText !== "string") {
          return fail(`'${operation}' requires 'newText'.`);
        }

        if (operation === "append") {
          updated = raw + (raw.length > 0 && !raw.endsWith("\n") ? "\n" : "") + newText;
        } else {
          updated = newText + raw;
        }
        linesChanged = newText.split("\n").length;
      }

      if (updated === raw) {
        return {
          path: path.relative(ROOT_WORKSPACE, safePath),
          operation,
          changed: false,
          message: "Edit produced no change to the file.",
          success: true,
        };
      }

      await fs.writeFile(safePath, updated, "utf-8");

      return {
        path: path.relative(ROOT_WORKSPACE, safePath),
        operation,
        changed: true,
        linesChanged,
        totalLines: updated.split("\n").length,
        bytesWritten: Buffer.byteLength(updated, "utf-8"),
        success: true,
      };
    } catch (err: any) {
      return fail(err.message);
    }
  },
};
