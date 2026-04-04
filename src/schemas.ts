import { z } from "zod";
import axios from "axios";

// ==========================================
// Mapeamentos de Nós Nativos Dify (Zod Strict)
// Zod schemas para poupar tokens do LLM ao predizer configs, forçando estrutura rígida.
// ==========================================

export const baseNodeSchema = z.object({
  title: z.string().optional(),
  desc: z.string().optional()
});

export const ifElseSchema = baseNodeSchema.extend({
  cases: z.array(z.object({
    case_id: z.string(),
    logical_operator: z.enum(['and', 'or']),
    conditions: z.array(z.any())
  }))
});

export const codeSchema = baseNodeSchema.extend({
  code: z.string(),
  code_language: z.enum(['python3', 'javascript']),
  outputs: z.record(z.object({
    type: z.string(),
    children: z.any().nullable().optional()
  })),
  variables: z.array(z.object({
    variable: z.string(),
    value_selector: z.array(z.string())
  }))
});

export const httpRequestSchema = baseNodeSchema.extend({
  method: z.enum(['get', 'post', 'put', 'patch', 'delete', 'head']),
  url: z.string(),
  authorization: z.object({
    type: z.enum(['no-auth', 'api-key', 'bearer']),
    config: z.any().nullable().optional()
  }),
  headers: z.string(),
  params: z.string(),
  body: z.object({
    type: z.enum(['none', 'json', 'text', 'raw-text', 'form-data', 'x-www-form-urlencoded']),
    data: z.array(z.any())
  }),
  timeout: z.object({
    max_connect_timeout: z.number().default(0),
    max_read_timeout: z.number().default(0),
    max_write_timeout: z.number().default(0)
  }),
  retry_config: z.object({
    max_retries: z.number().default(3),
    retry_enabled: z.boolean().default(true),
    retry_interval: z.number().default(100)
  }),
  ssl_verify: z.boolean().default(true),
  variables: z.array(z.any())
});

export const templateTransformSchema = baseNodeSchema.extend({
  template: z.string(),
  variables: z.array(z.any())
});

export const parameterExtractorSchema = baseNodeSchema.extend({
  model: z.object({
    provider: z.string(),
    name: z.string(),
    mode: z.string(),
    completion_params: z.object({
      temperature: z.number().optional()
    })
  }),
  query: z.array(z.string()),
  reasoning_mode: z.string(),
  vision: z.object({ enabled: z.boolean() }).optional()
});

export const knowledgeRetrievalSchema = baseNodeSchema.extend({
  dataset_ids: z.array(z.string()),
  retrieval_mode: z.string().default("multiple"),
  multiple_retrieval_config: z.object({
    reranking_enable: z.boolean().default(false),
    top_k: z.number().default(4)
  }).optional(),
  query_variable_selector: z.array(z.string()),
  query_attachment_selector: z.array(z.string()).optional()
});


// Mapping string table
const NATIVE_SCHEMAS: Record<string, z.ZodTypeAny> = {
  "if-else": ifElseSchema,
  "code": codeSchema,
  "http-request": httpRequestSchema,
  "template-transform": templateTransformSchema,
  "parameter-extractor": parameterExtractorSchema,
  "knowledge-retrieval": knowledgeRetrievalSchema
};

/**
 * Validates a node structure using local Zod patterns or falls back to Marketplace.
 */
export async function validateNodePayload(nodeType: string, nodeConfig: any) {
  const result = { valid: true, warnings: [] as string[] };
  
  // 1. Local Native Schema Verification
  if (NATIVE_SCHEMAS[nodeType]) {
     try {
       NATIVE_SCHEMAS[nodeType].parse(nodeConfig);
       return result; // Successfully matched tightly coupled generic schemas
     } catch (err: any) {
       throw new Error(`[Zod Native Local Error] Failed to validate standard node ${nodeType}:\n${err.message}`);
     }
  }

  // 2. Fallback to Marketplace
  const marketplaceUrl = "https://marketplace.dify.ai/api/v1/collections/__recommended-plugins-tools/plugins";
  try {
     const res = await axios.post(marketplaceUrl, { limit: 500 });
     const allPlugins = res.data?.plugins || [];
     
     // Very naive existence check for plugin endpoints
     const found = allPlugins.find((p: any) => p.name === nodeType);
     if (found) {
         result.warnings.push(`[WARNING FOR MAINTAINER] The local schema for plugin '${nodeType}' is missing or outdated. It passed validation only lazily via Marketplace lookup. Please update src/schemas.ts with the strict signature.`);
         return result;
     } else {
         // It might be a custom workflow tool (not a standard node, nor a Dify marketplace plugin)
         // e.g. "workflow" or "custom-tool"
         result.warnings.push(`[WARNING] Node type '${nodeType}' was neither found in local native Zod schemas nor in the official Dify Marketplace. Injecting it anyway, but it may cause UI crashes if unsupported.`);
         return result;
     }
  } catch (apiError) {
     result.warnings.push(`[WARNING] Could not connect to Dify Marketplace to validate unknown plugin type '${nodeType}'. Proceeding blindly!`);
     return result;
  }
}
