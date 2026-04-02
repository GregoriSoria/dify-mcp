import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosError } from "axios";
import yaml from "yaml";

const server = new McpServer({
  name: "dify-mcp",
  version: "1.0.0",
});

// Helper for Dify Axios Client
const createDifyClient = (baseURL: string, cookieString: string) => {
  // Extract CSRF token from cookie if it exists (usually __Host-csrf_token or dify_csrf_token)
  const match = cookieString.match(/__Host-csrf_token=([^;]+)/) || cookieString.match(/csrf_token=([^;]+)/);
  const csrfToken = match ? match[1] : '';

  return axios.create({
    baseURL,
    headers: {
      "Cookie": cookieString,
      "X-CSRF-Token": csrfToken,
      "Content-Type": "application/json",
    },
  });
};

const handleAxiosError = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      return `Authentication failed (Status ${error.response.status}). The console bearer token might be expired or invalid.`;
    }
    return `API Error: ${error.response?.status} - ${JSON.stringify(error.response?.data || error.message)}`;
  }
  return `An unexpected error occurred: ${(error as Error).message}`;
};

// 1. get_workflow_dsl
server.tool(
  "get_workflow_dsl",
  "Fetches the YAML DSL of a Dify workflow via the console API",
  {
    app_id: z.string().describe("The Application ID"),
    console_bearer_token: z.string().describe("The Bearer token from an active Dify admin session"),
    base_url: z.string().url().describe("The base URL of the Dify instance (e.g. https://cloud.dify.ai)"),
  },
  async ({ app_id, console_bearer_token, base_url }) => {
    try {
      const client = createDifyClient(base_url, console_bearer_token);
      // Typical Dify export route - reverse engineered from the console
      const response = await client.get(`/console/api/apps/${app_id}/export`);
      
      // The response payload on export usually contains a "data" field or the YAML directly
      let yamlData = response.data;
      if (typeof yamlData === "object" && yamlData.data) {
        yamlData = yamlData.data;
      }
      
      // Parse YAML to JSON/TS literal for the LLM to understand better
      const parsedJson = yaml.parse(yamlData);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ yamlData, parsedJson }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleAxiosError(error) }],
        isError: true,
      };
    }
  }
);

// 2. update_workflow_dsl
server.tool(
  "update_workflow_dsl",
  "Updates the YAML DSL of a Dify workflow via the console API",
  {
    app_id: z.string().describe("The Application ID"),
    new_yaml_content: z.string().describe("The new YAML string to save as the workflow DSL"),
    console_bearer_token: z.string().describe("The Bearer token from an active Dify admin session"),
    base_url: z.string().url().describe("The base URL of the Dify instance (e.g. https://cloud.dify.ai)"),
  },
  async ({ app_id, new_yaml_content, console_bearer_token, base_url }) => {
    try {
      const client = createDifyClient(base_url, console_bearer_token);
      
      // Emulating the import/overwrite function found in Dify console
      // The exact payload depends on Dify's route. Usually it's /imports or /import/overwrite
      // Assuming a generic payload structure observed in Dify imports:
      const payload = {
        mode: "yaml-content",
        yaml_content: new_yaml_content,
        app_id: app_id
      };

      // Tries a PUT to overwrite existing setup. If it's a specific import endpoint, it could be a POST
      // Tries a POST to the imports route
      const response = await client.post(`/console/api/apps/imports`, payload);

      return {
        content: [
          {
            type: "text",
            text: `Workflow updated successfully. Status: ${response.status}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleAxiosError(error) }],
        isError: true,
      };
    }
  }
);

// 3. inject_node_into_workflow
server.tool(
  "inject_node_into_workflow",
  "Parses current YAML, injects a new node into the graph, connects it to an optional source node, and returns the modified YAML.",
  {
    current_yaml: z.string().describe("The existing workflow YAML string"),
    node_type: z.string().describe("The Dify node type (e.g. 'llm', 'http-request')"),
    node_config: z.any().describe("A JSON object representing the internal 'data' configuration for the new node"),
    source_node_id: z.string().optional().describe("If provided, creates an edge from this node to the newly injected node"),
  },
  async ({ current_yaml, node_type, node_config, source_node_id }) => {
    try {
      const doc = yaml.parse(current_yaml);
      
      const workflowSection = doc.workflow ? doc.workflow : doc;
      if (!workflowSection || !workflowSection.graph) {
        throw new Error("Invalid DSL format: 'graph' object not found in YAML.");
      }

      const newNodeId = new Date().getTime().toString();
      
      // Ensure 'nodes' array exists
      if (!Array.isArray(workflowSection.graph.nodes)) {
        workflowSection.graph.nodes = [];
      }

      const newNode = {
        data: {
            title: node_config?.title || "Novo Nó",
            type: node_type,
            ...node_config
        },
        height: 100,
        id: newNodeId,
        position: { x: 50, y: 50 },
        positionAbsolute: { x: 50, y: 50 },
        sourcePosition: "right",
        targetPosition: "left",
        type: "custom",
        width: 242
      };

      workflowSection.graph.nodes.push(newNode);

      // Handle edge insertion
      if (source_node_id) {
        if (!Array.isArray(workflowSection.graph.edges)) {
          workflowSection.graph.edges = [];
        }

        const newEdgeId = `edge-${source_node_id}-to-${newNodeId}`;
        const newEdge = {
          data: {
             sourceType: "unknown",
             targetType: node_type
          },
          id: newEdgeId,
          source: source_node_id,
          sourceHandle: "source",
          target: newNodeId,
          targetHandle: "target",
          type: "custom"
        };

        workflowSection.graph.edges.push(newEdge);
      }

      // Convert back to YAML
      const updatedYaml = yaml.stringify(doc, { indent: 2 });

      return {
        content: [
          {
            type: "text",
            text: updatedYaml,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to parse/modify YAML: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Dify MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error explicitly occurred:", error);
  process.exit(1);
});
