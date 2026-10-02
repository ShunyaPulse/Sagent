import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  fileWriterTool,
  fileReaderTool,
  fileEditorTool,
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

test("resolveSafePath: blocks sibling paths sharing the workspace prefix", () => {
  const sibling = `${process.cwd()}-evil/secret.txt`;
  assert.throws(() => resolveSafePath(sibling), /Access Denied/);
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

test("fileEditorTool: replace, insert, delete, append and prepend", async () => {
  const testFile = "scratch/test-file-ops/edit.txt";
  await fileWriterTool.execute(
    { path: testFile, content: "alpha\nbeta\ngamma\n", overwrite: true },
    mockContext,
  );

  // replace (unique)
  const replaceRes = await fileEditorTool.execute(
    { path: testFile, operation: "replace", oldText: "beta", newText: "BETA" },
    mockContext,
  );
  assert.equal(replaceRes.success, true);

  // insert before line 2
  await fileEditorTool.execute(
    { path: testFile, operation: "insert", line: 2, newText: "inserted" },
    mockContext,
  );

  // delete 2 lines starting at line 1
  await fileEditorTool.execute(
    { path: testFile, operation: "delete", line: 1, count: 2 },
    mockContext,
  );

  // append and prepend
  await fileEditorTool.execute(
    { path: testFile, operation: "append", newText: "delta" },
    mockContext,
  );
  await fileEditorTool.execute(
    { path: testFile, operation: "prepend", newText: "start\n" },
    mockContext,
  );

  const final = await fileReaderTool.execute(
    { path: testFile, maxLines: 50 },
    mockContext,
  );
  assert.equal(final.content, "start\nBETA\ngamma\ndelta");

  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

test("fileEditorTool: rejects ambiguous replace and invalid target", async () => {
  const testFile = "scratch/test-file-ops/ambiguous.txt";
  await fileWriterTool.execute(
    { path: testFile, content: "dup\ndup\n", overwrite: true },
    mockContext,
  );

  const ambiguous = await fileEditorTool.execute(
    { path: testFile, operation: "replace", oldText: "dup", newText: "x" },
    mockContext,
  );
  assert.equal(ambiguous.success, false);
  assert.match(ambiguous.error, /matched 2 times/);

  const replaceAll = await fileEditorTool.execute(
    {
      path: testFile,
      operation: "replace",
      oldText: "dup",
      newText: "x",
      replaceAll: true,
    },
    mockContext,
  );
  assert.equal(replaceAll.success, true);

  const missing = await fileEditorTool.execute(
    { path: "scratch/test-file-ops/does-not-exist.txt", operation: "append", newText: "x" },
    mockContext,
  );
  assert.equal(missing.success, false);
  assert.match(missing.error, /File not found/);

  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

test("fileEditorTool: schema applies defaults for count and replaceAll", () => {
  const parsed = fileEditorTool.parameters.parse({
    path: "notes.txt",
    operation: "append",
    newText: "hello",
  });
  assert.equal(parsed.count, 1);
  assert.equal(parsed.replaceAll, false);
});
