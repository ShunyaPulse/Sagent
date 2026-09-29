import { z } from "zod";
import { AgentTool } from "../core/types.js";
import { query } from "../db/postgres.js";
import { getEmbeddingProvider } from "../providers/index.js";

const sqlVectorSearchSchema = z
  .object({
    searchQuery: z.string().optional().describe("Semantic search query string"),
    query: z.string().optional().describe("Alias for searchQuery"),
    limit: z.coerce.number().int().min(1).max(10).default(4),
    minSimilarity: z.coerce.number().min(0).max(1).default(0.4),
  })
  .transform((data) => ({
    searchQuery: (data.searchQuery || data.query || "").trim(),
    limit: data.limit,
    minSimilarity: data.minSimilarity,
  }))
  .refine((data) => data.searchQuery.length >= 2, {
    message:
      'Search query must be at least 2 characters long (use "searchQuery" or "query")',
  });

export const sqlVectorSearchTool: AgentTool<typeof sqlVectorSearchSchema> = {
  name: "sql_vector_search",
  description:
    "Performs semantic vector search across Neon PostgreSQL knowledge base (pgvector) to find relevant documents, policies, or facts.",
  parameters: sqlVectorSearchSchema,
  execute: async ({ searchQuery, limit, minSimilarity }, context) => {
    // 1. Generate 768-dim embedding for search query
    const embeddingProvider = getEmbeddingProvider();
    const queryVector = await embeddingProvider.embed(searchQuery);
    const vectorString = `[${queryVector.join(",")}]`;

    // 2. Query Neon DB with cosine distance operator <=>
    const sql = `
      SELECT 
        id,
        title,
        content,
        metadata,
        1 - (embedding <=> $1::vector) AS similarity
      FROM agent_knowledge
      WHERE tenant_id = $2
        AND (1 - (embedding <=> $1::vector)) >= $3
      ORDER BY embedding <=> $1::vector ASC
      LIMIT $4;
    `;

    const result = await query(sql, [
      vectorString,
      context.tenantId || "default",
      minSimilarity,
      limit,
    ]);

    if (result.rows.length === 0) {
      return {
        message:
          "No relevant documents found matching the search query with sufficient similarity.",
        resultsCount: 0,
        matches: [],
      };
    }

    return {
      resultsCount: result.rows.length,
      matches: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        content: row.content,
        similarity: parseFloat(row.similarity.toFixed(4)),
        metadata: row.metadata,
      })),
    };
  },
};
