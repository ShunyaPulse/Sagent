import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataCalculatorTool } from './data-calculator.js';

test('dataCalculatorTool: calculates standard arithmetic correctly', async () => {
  const result = await dataCalculatorTool.execute(
    { expression: '(450 * 1.18) - 50', precision: 2 },
    { sessionId: 'test', tenantId: 'default' }
  );

  assert.equal(result.result, 481);
  assert.equal(result.error, undefined);
});

test('dataCalculatorTool: safely handles Math methods', async () => {
  const result = await dataCalculatorTool.execute(
    { expression: 'Math.sqrt(144) + Math.round(5.6)', precision: 0 },
    { sessionId: 'test', tenantId: 'default' }
  );

  assert.equal(result.result, 18);
});

test('dataCalculatorTool: blocks forbidden characters and injection', async () => {
  const result = await dataCalculatorTool.execute(
    { expression: 'process.exit(1)', precision: 2 },
    { sessionId: 'test', tenantId: 'default' }
  );

  assert.ok(result.error);
  assert.match(result.error, /Forbidden characters detected/);
});
