import { z } from "zod";
import { AgentTool } from "../core/types.js";

const calculatorSchema = z.object({
  expression: z
    .string()
    .describe(
      'Arithmetic expression to compute, e.g. " (450 * 1.18) - 50 " or "Math.sqrt(144) + 25"',
    ),
  precision: z.coerce.number().int().min(0).max(10).default(4),
});

/**
 * Evaluates mathematical expressions safely by parsing only numbers, math operators, and Math object methods.
 * Strictly prohibits any access to process, window, global, require, or prototypes.
 */
function safeMathEval(expr: string): number {
  // Disallow any characters except numbers, whitespace, standard arithmetic operators, parentheses, commas, and Math.* functions
  const sanitized = expr.replace(/\s+/g, "");

  if (
    !/^([0-9\.\+\-\*\/\%\(\)\,]|Math\.(abs|acos|asin|atan|ceil|cos|exp|floor|log|max|min|pow|random|round|sin|sqrt|tan|PI|E))+$/.test(
      sanitized,
    )
  ) {
    throw new Error(
      "Forbidden characters detected in math expression. Only standard arithmetic and Math methods are permitted.",
    );
  }

  // Safe Function evaluation with no scope
  const func = new Function(`return (${sanitized});`);
  const result = func();

  if (typeof result !== "number" || isNaN(result)) {
    throw new Error(`Expression did not evaluate to a valid number: ${expr}`);
  }

  return result;
}

export const dataCalculatorTool: AgentTool<typeof calculatorSchema> = {
  name: "data_calculator",
  description:
    "Safely calculates mathematical expressions, arithmetic, percentages, and scientific formulas with guaranteed precision.",
  parameters: calculatorSchema,
  execute: async ({ expression, precision }) => {
    try {
      const rawResult = safeMathEval(expression);
      const rounded = Number(rawResult.toFixed(precision));
      return {
        expression,
        result: rounded,
        rawResult,
      };
    } catch (err: any) {
      return {
        error: err.message,
        expression,
      };
    }
  },
};
