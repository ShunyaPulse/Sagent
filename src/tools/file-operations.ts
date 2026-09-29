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

  if (!absolutePath.startsWith(ROOT_WORKSPACE)) {
    throw new Error(
      `Access Denied: Path traversal detected. "${targetPath}" is outside the authorized workspace.`,
    );
  }

  const relativeFromRoot = path.relative(ROOT_WORKSPACE, absolutePath);
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
      // Check if file was provided from client workspace snapshot
      if (context?.localFiles && context.localFiles[targetPath]) {
        const raw = context.localFiles[targetPath];
        const lines = raw.split("\n");
        const truncated = lines.length > maxLines;
        const content = truncated ? lines.slice(0, maxLines).join("\n") : raw;
        return {
          path: targetPath,
          content,
          totalLines: lines.length,
          truncated,
          source: "client_workspace",
        };
      }

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
// 4. File Patcher Tool (Surgical Search & Replace)
// -----------------------------------------------------------------------------
const filePatcherSchema = z.object({
  path: z
    .string()
    .describe("Relative path of the file to modify within the workspace"),
  targetContent: z
    .string()
    .describe(
      "The exact contiguous block of code/text to find and replace. Must match existing text in the file.",
    ),
  replacementContent: z
    .string()
    .describe("The new code/text to replace the targetContent with."),
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
    "Surgically replaces a specific block of text/code in an existing file without rewriting the entire file. Prevents accidental truncation.",
  parameters: filePatcherSchema,
  execute: async (
    {
      path: targetPath,
      targetContent,
      replacementContent,
      allowMultiple,
    },
    context,
  ) => {
    try {
      const safePath = resolveSafePath(targetPath);
      let raw: string = "";
      if (
        context?.localFiles &&
        (context.localFiles[targetPath] ||
          context.localFiles[path.basename(targetPath)])
      ) {
        raw =
          context.localFiles[targetPath] ||
          context.localFiles[path.basename(targetPath)];
      } else {
        try {
          raw = await fs.readFile(safePath, "utf-8");
        } catch {
          return {
            error: `File not found at "${targetPath}". Use file_writer if you want to create a new file.`,
            success: false,
          };
        }
      }

      if (!targetContent) {
        return {
          error: "targetContent cannot be empty.",
          success: false,
        };
      }

      const occurrences = raw.split(targetContent).length - 1;

      if (occurrences === 0) {
        return {
          error: `targetContent not found in "${targetPath}". Ensure exact whitespace, indentation, and casing match the target file.`,
          success: false,
        };
      }

      if (occurrences > 1 && !allowMultiple) {
        return {
          error: `targetContent matched ${occurrences} times in "${targetPath}". Provide more surrounding context to match a unique block, or set allowMultiple: true.`,
          success: false,
        };
      }

      const updated = allowMultiple
        ? raw.replaceAll(targetContent, replacementContent)
        : raw.replace(targetContent, replacementContent);

      await fs.writeFile(safePath, updated, "utf-8");

      return {
        path: path.relative(ROOT_WORKSPACE, safePath),
        success: true,
        replacementsMade: allowMultiple ? occurrences : 1,
        bytesBefore: Buffer.byteLength(raw, "utf-8"),
        bytesAfter: Buffer.byteLength(updated, "utf-8"),
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
