import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  fileWriterTool,
  fileReaderTool,
  directoryListerTool,
  resolveSafePath,
} from "./file-operations.js";

const TEST_DIR = path.resolve(process.cwd(), "scratch/test-file-ops");
const mockContext = { sessionId: "test-session", tenantId: "default" };

test("resolveSafePath: allows authorized workspace paths", () => {
  const safe = resolveSafePath("src/server.ts");
  assert.equal(safe, path.resolve(process.cwd(), "src/server.ts"));
});

test("resolveSafePath: blocks path traversal attacks", () => {
  assert.throws(
    () => resolveSafePath("../../../etc/passwd"),
    /Access Denied: Path traversal detected/,
  );
});

test("resolveSafePath: blocks protected sensitive files (.env, .git)", () => {
  assert.throws(() => resolveSafePath(".env"), /Security Policy Violation/);
  assert.throws(
    () => resolveSafePath(".env.local"),
    /Security Policy Violation/,
  );
});

test("fileWriterTool & fileReaderTool: creates, reads, and cleans up workspace file", async () => {
  const testFile = "scratch/test-file-ops/hello.txt";
  const testContent = "Hello from Sagentic File Writer!\nLine 2 content.";

  // 1. Write File
  const writeRes = await fileWriterTool.execute(
    { path: testFile, content: testContent, overwrite: true },
    mockContext,
  );
  assert.equal(writeRes.success, true);
  assert.equal(writeRes.error, undefined);

  // 2. Read File
  const readRes = await fileReaderTool.execute(
    { path: testFile, maxLines: 50 },
    mockContext,
  );
  assert.equal(readRes.content, testContent);
  assert.equal(readRes.totalLines, 2);

  // 3. Directory Lister
  const listRes = await directoryListerTool.execute(
    { path: "scratch/test-file-ops", maxDepth: 1 },
    mockContext,
  );
  assert.ok(Array.isArray(listRes.entries));
  const found = listRes.entries.some((e: any) => e.name === "hello.txt");
  assert.equal(found, true);

  // Cleanup
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});
