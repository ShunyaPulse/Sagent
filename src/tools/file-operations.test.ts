import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  fileWriterTool,
  fileReaderTool,
  directoryListerTool,
  filePatcherTool,
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

test("filePatcherTool: surgical search-and-replace edits", async () => {
  const patchFile = "scratch/test-file-ops/patch-me.txt";
  const initialContent = `function calculateSum(a: number, b: number) {
  // TODO: implement
  return 0;
}`;

  await fileWriterTool.execute(
    { path: patchFile, content: initialContent, overwrite: true },
    mockContext,
  );

  // 1. Successful surgical replacement
  const patchRes = await filePatcherTool.execute(
    {
      path: patchFile,
      targetContent: "  // TODO: implement\n  return 0;",
      replacementContent: "  return a + b;",
      allowMultiple: false,
    },
    mockContext,
  );
  assert.equal(patchRes.success, true);
  assert.equal(patchRes.replacementsMade, 1);

  // Verify updated content
  const readRes = await fileReaderTool.execute(
    { path: patchFile, maxLines: 50 },
    mockContext,
  );
  assert.equal(
    readRes.content,
    "function calculateSum(a: number, b: number) {\n  return a + b;\n}",
  );

  // 2. Error when targetContent not found
  const notFoundRes = await filePatcherTool.execute(
    {
      path: patchFile,
      targetContent: "non_existent_code_block",
      replacementContent: "new_code",
      allowMultiple: false,
    },
    mockContext,
  );
  assert.equal(notFoundRes.success, false);
  assert.match(notFoundRes.error, /targetContent not found/);

  // 3. Error when multiple occurrences without allowMultiple
  const multiFile = "scratch/test-file-ops/multi.txt";
  await fileWriterTool.execute(
    { path: multiFile, content: "foo bar foo baz", overwrite: true },
    mockContext,
  );

  const ambiguousRes = await filePatcherTool.execute(
    {
      path: multiFile,
      targetContent: "foo",
      replacementContent: "qux",
      allowMultiple: false,
    },
    mockContext,
  );
  assert.equal(ambiguousRes.success, false);
  assert.match(ambiguousRes.error, /matched 2 times/);

  // 4. Successful multiple replacement with allowMultiple: true
  const multiSuccessRes = await filePatcherTool.execute(
    {
      path: multiFile,
      targetContent: "foo",
      replacementContent: "qux",
      allowMultiple: true,
    },
    mockContext,
  );
  assert.equal(multiSuccessRes.success, true);
  assert.equal(multiSuccessRes.replacementsMade, 2);

  const finalRead = await fileReaderTool.execute(
    { path: multiFile, maxLines: 10 },
    mockContext,
  );
  assert.equal(finalRead.content, "qux bar qux baz");

  // 5. Surgical text deletion when replacementContent is omitted (defaults to "")
  const parsedArgs = filePatcherTool.parameters.parse({
    path: multiFile,
    targetContent: "qux bar ",
  });
  assert.equal(parsedArgs.replacementContent, "");

  const deleteRes = await filePatcherTool.execute(parsedArgs, mockContext);
  assert.equal(deleteRes.success, true);

  const afterDeleteRead = await fileReaderTool.execute(
    { path: multiFile, maxLines: 10 },
    mockContext,
  );
  assert.equal(afterDeleteRead.content, "qux baz");

  // 6. Quoted targetContent matching (e.g., "'in harmony'" matching "in harmony")
  const harmonyFile = "scratch/test-file-ops/harmony.txt";
  await fileWriterTool.execute(
    { path: harmonyFile, content: "Living in harmony", overwrite: true },
    mockContext,
  );
  const harmonyRes = await filePatcherTool.execute(
    {
      path: harmonyFile,
      targetContent: "'in harmony'",
      replacementContent: "at peace",
    },
    mockContext,
  );
  assert.equal(harmonyRes.success, true);

  const afterHarmonyRead = await fileReaderTool.execute(
    { path: harmonyFile, maxLines: 10 },
    mockContext,
  );
  assert.equal(afterHarmonyRead.content, "Living at peace");

  // 7. Fuzzy matching on client localFiles (e.g. "Muskan" matching "Muskan.txt")
  const clientContext = {
    ...mockContext,
    localFiles: {
      "Muskan.txt": "Line 1 in harmony",
    },
  };
  const fuzzyPatchRes = await filePatcherTool.execute(
    {
      path: "Muskan",
      targetContent: " in harmony",
      replacementContent: "",
    },
    clientContext,
  );
  assert.equal(fuzzyPatchRes.success, true);
  assert.equal(fuzzyPatchRes.path, "Muskan.txt");
  assert.equal(clientContext.localFiles["Muskan.txt"], "Line 1");

  // Cleanup
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});
