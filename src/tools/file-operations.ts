import { promises as fs, existsSync } from "node:fs";
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

/**
 * Finds a matching file in client workspace snapshot (supports exact, case-insensitive, and extension-agnostic match).
 */
export function findInLocalFiles(
  localFiles: Record<string, string> | undefined,
  targetPath: string,
): { matchedPath: string; content: string } | null {
  if (!localFiles) return null;
  // 1. Direct exact key match
  if (localFiles[targetPath]) {
    return { matchedPath: targetPath, content: localFiles[targetPath] };
  }
  const base = path.basename(targetPath);
  if (localFiles[base]) {
    return { matchedPath: base, content: localFiles[base] };
  }

  // 2. Case-insensitive exact match
  const lowerTarget = targetPath.toLowerCase();
  const lowerBase = base.toLowerCase();
  for (const [k, v] of Object.entries(localFiles)) {
    if (k.toLowerCase() === lowerTarget || k.toLowerCase() === lowerBase) {
      return { matchedPath: k, content: v };
    }
  }

  // 3. Extension-agnostic match (e.g. "Muskan" matches "Muskan.txt", "Muskan.md")
  for (const [k, v] of Object.entries(localFiles)) {
    const kBase = path.parse(k).name.toLowerCase();
    if (kBase === lowerBase || kBase === lowerTarget) {
      return { matchedPath: k, content: v };
    }
  }

  return null;
}

/**
 * Searches disk for the file, falling back to common text extensions if extension was omitted.
 */
export async function findOnDiskWithExtensions(
  safePath: string,
): Promise<string | null> {
  try {
    await fs.access(safePath);
    return safePath;
  } catch {}
  const exts = [".txt", ".md", ".json", ".ts", ".js", ".html", ".css", ".py"];
  for (const ext of exts) {
    try {
      const candidate = safePath + ext;
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

// -----------------------------------------------------------------------------
// 1. File Writer Tool
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
const fileWriterSchema = z.object({
  path: z
    .coerce
    .string()
    .describe(
      "Relative path of the file to create or write, e.g. 'src/utils/math.ts' or 'notes.txt'",
    ),
  content: z
    .coerce
    .string()
    .describe("Text or code content to write to the file"),
  overwrite: z
    .boolean()
    .default(true)
    .describe("Whether to overwrite if file already exists"),
  append: z
    .boolean()
    .default(false)
    .describe(
      "Whether to append content to the end of the file instead of overwriting",
    ),
});

export const fileWriterTool: AgentTool<typeof fileWriterSchema> = {
  name: "file_writer",
  description:
    "Creates a new file or overwrites/appends to an existing file within the workspace with safety checks.",
  parameters: fileWriterSchema,
  execute: async ({ path: targetPath, content, overwrite, append }) => {
    try {
      const safePath = resolveSafePath(targetPath);

      if (!overwrite && !append) {
        try {
          await fs.access(safePath);
          return {
            error: `File already exists at "${targetPath}". Set overwrite: true to replace it or append: true to add content.`,
            success: false,
          };
        } catch {
          // File does not exist, proceed
        }
      }

      // Ensure parent directories exist
      await fs.mkdir(path.dirname(safePath), { recursive: true });

      if (append) {
        await fs.appendFile(safePath, content, "utf-8");
      } else {
        await fs.writeFile(safePath, content, "utf-8");
      }

      const bytesWritten = Buffer.byteLength(content, "utf-8");
      return {
        path: path.relative(ROOT_WORKSPACE, safePath),
        bytesWritten,
        mode: append ? "appended" : "written",
        success: true,
        message: `File "${targetPath}" successfully ${append ? "appended" : "written"} (${bytesWritten} bytes). Task complete. Provide your final response.`,
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
  execute: async ({ path: targetPath, maxLines }, context) => {
    try {
      // 1. Check client workspace snapshot first (exact, case-insensitive, or extension-agnostic)
      const localMatch = findInLocalFiles(context?.localFiles, targetPath);
      if (localMatch) {
        const raw = localMatch.content;
        const lines = raw.split("\n");
        const truncated = lines.length > maxLines;
        const content = truncated ? lines.slice(0, maxLines).join("\n") : raw;
        return {
          path: localMatch.matchedPath,
          content,
          totalLines: lines.length,
          truncated,
          source: "client_workspace",
        };
      }

      // 2. Resolve disk path with extension fallback
      const safePath = resolveSafePath(targetPath);
      const diskPath = (await findOnDiskWithExtensions(safePath)) || safePath;
      const raw = await fs.readFile(diskPath, "utf-8");
      const lines = raw.split("\n");
      const truncated = lines.length > maxLines;
      const content = truncated ? lines.slice(0, maxLines).join("\n") : raw;

      return {
        path: path.relative(ROOT_WORKSPACE, diskPath),
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
  execute: async ({ path: targetPath, maxDepth }, context) => {
    try {
      // If client workspace files provided, return them directly
      if (context?.workspaceFiles && context.workspaceFiles.length > 0) {
        return {
          directory: targetPath,
          source: "client_workspace",
          entries: context.workspaceFiles.map((name: string) => ({
            name,
            path: name,
            type: name.endsWith("/") ? "directory" : "file",
          })),
        };
      }

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
    .optional()
    .describe(
      "Line number to target (1-based index, or -1 for the last line of the file; defaults to -1 for 'delete')",
    ),
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
  execute: async (
    {
      path: targetPath,
      operation,
      oldText,
      newText,
      line,
      count,
      replaceAll,
    },
    context,
  ) => {
    const fail = (error: string) => ({ error, path: targetPath, success: false });

    try {
      // 1. Check client workspace snapshot first (exact, case-insensitive, or extension-agnostic)
      const localMatch = findInLocalFiles(context?.localFiles, targetPath);
      let raw: string;
      let resolvedFilePath = targetPath;
      let safePath: string | null = null;

      if (localMatch) {
        raw = localMatch.content;
        resolvedFilePath = localMatch.matchedPath;
        try {
          const resolved = resolveSafePath(resolvedFilePath);
          if (existsSync(resolved)) {
            safePath = resolved;
          }
        } catch {}
      } else {
        safePath = resolveSafePath(targetPath);
        const diskPath = await findOnDiskWithExtensions(safePath);
        if (!diskPath) {
          return fail(
            `File not found at "${targetPath}". Use the file_writer tool to create it first.`,
          );
        }
        safePath = diskPath;
        resolvedFilePath = path.relative(ROOT_WORKSPACE, diskPath);
        raw = await fs.readFile(safePath, "utf-8");
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
        const lines = raw.split("\n");
        let targetLine = line === undefined ? lines.length + 1 : line;
        if (targetLine < 0) {
          targetLine = lines.length + targetLine + 2;
        }
        if (targetLine < 1 || targetLine > lines.length + 1) {
          return fail(
            `Line ${line} is out of range: "${targetPath}" has ${lines.length} lines.`,
          );
        }

        const inserted = newText.split("\n");
        lines.splice(targetLine - 1, 0, ...inserted);
        updated = lines.join("\n");
        linesChanged = inserted.length;
      } else if (operation === "delete") {
        const lines = raw.split("\n");
        if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
          return fail(`"${targetPath}" is already empty.`);
        }

        let targetLine = line === undefined ? lines.length : line;
        if (targetLine < 0) {
          targetLine = lines.length + targetLine + 1;
        }

        if (targetLine < 1 || targetLine > lines.length) {
          return fail(
            `Line ${line} is out of range: "${targetPath}" has ${lines.length} lines.`,
          );
        }

        const removed = lines.splice(targetLine - 1, count);
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
          path: resolvedFilePath,
          operation,
          changed: false,
          message: "Edit produced no change to the file.",
          success: true,
        };
      }

      if (safePath) {
        await fs.writeFile(safePath, updated, "utf-8");
      }

      if (context?.localFiles) {
        context.localFiles[resolvedFilePath] = updated;
        context.localFiles[path.basename(resolvedFilePath)] = updated;
      }

      return {
        path: resolvedFilePath,
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

// -----------------------------------------------------------------------------
// 5. File Patcher Tool (Surgical Search & Replace)
// -----------------------------------------------------------------------------
const filePatcherSchema = z.object({
  path: z
    .coerce
    .string()
    .describe("Relative path of the file to modify within the workspace"),
  targetContent: z
    .coerce
    .string()
    .describe(
      "The exact contiguous block of code/text to find and replace. Must match existing text in the file.",
    ),
  replacementContent: z
    .coerce
    .string()
    .default("")
    .describe(
      "The new code/text to replace the targetContent with. Defaults to empty string '' (which surgically removes targetContent).",
    ),
  allowMultiple: z
    .boolean()
    .default(false)
    .describe(
      "If true, all occurrences of targetContent will be replaced. If false (default), targetContent must match exactly once.",
    ),
});

export const filePatcherTool: AgentTool<typeof filePatcherSchema> = {
  name: "file_patcher",
  description:
    "Surgically replaces a specific block of text/code in an existing file without rewriting the entire file. Set replacementContent to '' (default) to remove text.",
  parameters: filePatcherSchema,
  execute: async (
    {
      path: targetPath,
      targetContent,
      replacementContent = "",
      allowMultiple = false,
    },
    context,
  ) => {
    try {
      // 1. Check client workspace snapshot first (exact, case-insensitive, or extension-agnostic)
      const localMatch = findInLocalFiles(context?.localFiles, targetPath);
      let raw: string = "";
      let resolvedFilePath = targetPath;
      let safePath: string | null = null;

      if (localMatch) {
        raw = localMatch.content;
        resolvedFilePath = localMatch.matchedPath;
        try {
          const resolved = resolveSafePath(resolvedFilePath);
          if (existsSync(resolved)) {
            safePath = resolved;
          }
        } catch {}
      } else {
        safePath = resolveSafePath(targetPath);
        const diskPath = await findOnDiskWithExtensions(safePath);
        if (!diskPath) {
          return {
            error: `File not found at "${targetPath}". Use file_writer if you want to create a new file or directory_lister to find existing files.`,
            success: false,
          };
        }
        safePath = diskPath;
        resolvedFilePath = path.relative(ROOT_WORKSPACE, diskPath);
        raw = await fs.readFile(safePath, "utf-8");
      }

      if (!targetContent) {
        return {
          error: "targetContent cannot be empty.",
          success: false,
        };
      }

      // 1. Exact match attempt
      let searchTarget = targetContent;
      let occurrences = raw.split(searchTarget).length - 1;

      // 2. Fallback: Strip surrounding quotes if model passed literal quotes (e.g. 'in harmony' -> in harmony)
      if (occurrences === 0 && /^['"`].*['"`]$/.test(searchTarget)) {
        const unquoted = searchTarget.slice(1, -1);
        if (raw.includes(unquoted)) {
          searchTarget = unquoted;
          occurrences = raw.split(searchTarget).length - 1;
        }
      }

      // 3. Fallback: Normalize CRLF (Windows) to LF if matching failed
      if (occurrences === 0) {
        const rawLF = raw.replace(/\r\n/g, "\n");
        const targetLF = searchTarget.replace(/\r\n/g, "\n");
        if (rawLF.includes(targetLF)) {
          raw = rawLF;
          searchTarget = targetLF;
          occurrences = raw.split(searchTarget).length - 1;
        }
      }

      // 4. Fallback: Trim trailing/leading whitespace if present
      if (
        occurrences === 0 &&
        searchTarget.trim() &&
        raw.includes(searchTarget.trim())
      ) {
        searchTarget = searchTarget.trim();
        occurrences = raw.split(searchTarget).length - 1;
      }

      if (occurrences === 0) {
        return {
          error: `targetContent not found in "${resolvedFilePath}". Check file content with file_reader first to inspect the exact text.`,
          success: false,
        };
      }

      if (occurrences > 1 && !allowMultiple) {
        return {
          error: `targetContent matched ${occurrences} times in "${resolvedFilePath}". Provide more surrounding context to match a unique block, or set allowMultiple: true.`,
          success: false,
        };
      }

      const updated = allowMultiple
        ? raw.replaceAll(searchTarget, replacementContent)
        : raw.replace(searchTarget, replacementContent);

      if (safePath) {
        await fs.writeFile(safePath, updated, "utf-8");
      }

      if (context?.localFiles) {
        context.localFiles[resolvedFilePath] = updated;
        context.localFiles[path.basename(resolvedFilePath)] = updated;
      }

      return {
        path: resolvedFilePath,
        success: true,
        replacementsMade: allowMultiple ? occurrences : 1,
        bytesBefore: Buffer.byteLength(raw, "utf-8"),
        bytesAfter: Buffer.byteLength(updated, "utf-8"),
        message: `Successfully patched "${resolvedFilePath}".`,
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
