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
  maxDepth: z.coerce.number().int().min(1).max(3).default(2),
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
