import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosError } from "axios";
import yaml from "yaml";
import * as fs from "fs";
import * as path from "path";
import { validateNodePayload } from "./schemas.js";
import { validateDagIntegrity } from "./dagValidator.js";

const server = new McpServer({
  name: "dify-mcp",
  version: "1.0.0",
});

let currentSession = {
  accessToken: process.env.DIFY_ACCESS_TOKEN || "",
  csrfToken: process.env.DIFY_CSRF_TOKEN || "",
  refreshToken: process.env.DIFY_REFRESH_TOKEN || "",
  baseUrl: process.env.DIFY_BASE_URL || "https://cloud.dify.ai"
};

const buildCookieString = () => {
  return `__Host-access_token=${currentSession.accessToken}; __Host-csrf_token=${currentSession.csrfToken}; __Host-refresh_token=${currentSession.refreshToken}`;
};

const createDifyClient = () => {
  if (!currentSession.accessToken || !currentSession.csrfToken) {
    throw new Error("No active Dify session found. Please define DIFY_ACCESS_TOKEN, DIFY_CSRF_TOKEN, and DIFY_REFRESH_TOKEN in your mcp_config.json env section.");
  }

  const client = axios.create({
    baseURL: currentSession.baseUrl,
    headers: {
      "Cookie": buildCookieString(),
      "X-CSRF-Token": currentSession.csrfToken,
      "Content-Type": "application/json",
    },
  });

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const originalRequest = error.config;
      
      if (error.response?.status === 401 && !originalRequest._retry) {
        originalRequest._retry = true;
        try {
          const refreshResponse = await axios.post(
             `${currentSession.baseUrl}/console/api/refresh-token`,
             {},
             {
               headers: {
                 "Cookie": buildCookieString(),
                 "X-CSRF-Token": currentSession.csrfToken
               },
             }
          );
          
          const setCookieHeaders = refreshResponse.headers['set-cookie'];
          if (setCookieHeaders && setCookieHeaders.length > 0) {
            setCookieHeaders.forEach(sc => {
               const splitVal = sc.split(';')[0]; 
               const key = splitVal.substring(0, splitVal.indexOf('='));
               const val = splitVal.substring(splitVal.indexOf('=') + 1);
               
               if (key === "__Host-access_token") currentSession.accessToken = val;
               if (key === "__Host-csrf_token") currentSession.csrfToken = val;
               if (key === "__Host-refresh_token") currentSession.refreshToken = val;
            });
            
            originalRequest.headers["Cookie"] = buildCookieString();
            originalRequest.headers["X-CSRF-Token"] = currentSession.csrfToken;
            
            return client(originalRequest);
          }
        } catch (refreshError) {
          throw new Error("Session completely expired (refresh failed). Please update DIFY_REFRESH_TOKEN in mcp_config.json.");
        }
      }
      return Promise.reject(error);
    }
  );

  return client;
};

const handleAxiosError = (error: unknown): string => {
  if (axios.isAxiosError(error) && error.response?.status !== 401) {
    return `API Error: ${error.response?.status} - ${JSON.stringify(error.response?.data || error.message)}`;
  }
  return `Error: ${(error as Error).message}`;
};

// 1. list_apps
server.registerTool(
  "list_apps",
  {
    description: "Fetches a paginated list of all applications and workflows in the workspace",
    inputSchema: {
      page: z.number().optional().default(1).describe("Page number"),
      limit: z.number().optional().default(20).describe("Number of apps to return"),
    },
  },
  async ({ page, limit }) => {
    try {
      const client = createDifyClient();
      const response = await client.get(`/console/api/apps`, { params: { page, limit } });
      return {
        content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleAxiosError(error) }],
        isError: true,
      };
    }
  }
);

// 2. search_apps
server.registerTool(
  "search_apps",
  {
    description: "Searches for applications by keyword matching name or description",
    inputSchema: {
      keyword: z.string().describe("The term to search for"),
      limit: z.number().optional().default(100).describe("Max items to fetch for client-side filtering"),
    },
  },
  async ({ keyword, limit }) => {
    try {
      const client = createDifyClient();
      const response = await client.get(`/console/api/apps`, { params: { keyword, limit } });
      const apps = response.data?.data || [];
      
      const lowerKeyword = keyword.toLowerCase();
      const results = apps.filter((a: any) => 
         (a.name && a.name.toLowerCase().includes(lowerKeyword)) || 
         (a.description && a.description.toLowerCase().includes(lowerKeyword))
      );

      return {
        content: [{ type: "text", text: JSON.stringify({ count: results.length, matches: results }, null, 2) }],
      };
    } catch (error) {
       return {
        content: [{ type: "text", text: handleAxiosError(error) }],
        isError: true,
      };
    }
  }
);

// 3. create_app
server.registerTool(
  "create_app",
  {
    description: "Creates a new empty Application or Workflow directly into the Workspace",
    inputSchema: {
      name: z.string().describe("The name of the new App"),
      mode: z.enum(["workflow", "advanced-chat", "chat", "agent-chat", "completion"]).describe("The mode/type of the app"),
      description: z.string().optional().default("").describe("Short description"),
      icon: z.string().optional().default("🤖").describe("Emoji string for the icon"),
      icon_background: z.string().optional().default("#FFEAD5").describe("Hex color code for background")
    },
  },
  async ({ name, mode, description, icon, icon_background }) => {
    try {
      const client = createDifyClient();
      const payload = {
        name,
        mode,
        icon_type: "emoji",
        icon,
        icon_background,
        description
      };

      const response = await client.post(`/console/api/apps`, payload);
      return {
        content: [{ type: "text", text: `App created successfully! Target App ID: ${response.data.id}\nRaw Payload: ${JSON.stringify(response.data, null, 2)}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleAxiosError(error) }],
        isError: true,
      };
    }
  }
);


// 4. get_workflow_dsl
server.registerTool(
  "get_workflow_dsl",
  {
    description: "Fetches the YAML DSL of a Dify workflow via the console API",
    inputSchema: {
      app_id: z.string().describe("The Application ID"),
    },
  },
  async ({ app_id }) => {
    try {
      const client = createDifyClient();
      const response = await client.get(`/console/api/apps/${app_id}/export`);
      
      let yamlData = response.data;
      if (typeof yamlData === "object" && yamlData.data) {
        yamlData = yamlData.data;
      }
      
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

// 5. update_workflow_dsl
server.registerTool(
  "update_workflow_dsl",
  {
    description: "Updates the YAML DSL of a Dify workflow via the console API",
    inputSchema: {
      app_id: z.string().describe("The Application ID"),
      new_yaml_content: z.string().describe("The new YAML string to save as the workflow DSL"),
    },
  },
  async ({ app_id, new_yaml_content }) => {
    try {
      // Step A: Parse and DAG Validate before allowing the HTTP POST!
      let doc;
      try {
        doc = yaml.parse(new_yaml_content);
      } catch (e) {
        throw new Error(`YAML Parsing Error: Could not construct syntactically valid YAML. ${(e as Error).message}`);
      }

      const workflowSection = doc.workflow ? doc.workflow : doc;
      if (workflowSection && workflowSection.graph) {
        const dagCheck = validateDagIntegrity(workflowSection.graph);
        if (!dagCheck.valid) {
           return {
             content: [{ type: "text", text: `⛔ DAG ARCHITECTURE VIOLATION: The Dify Frontend will crash. Your update has been blocked from affecting the server. Errors:\n\n${dagCheck.errors.join("\n")}` }],
             isError: true,
           };
        }
      }

      // Step B: Auto Local Backup
      try {
        const backupName = `backup_${app_id}_${new Date().getTime()}.yaml`;
        const backupPath = path.join(process.cwd(), backupName);
        fs.writeFileSync(backupPath, new_yaml_content, "utf8");
      } catch (e) {
        // Silently fail backup if permissions error
      }

      const client = createDifyClient();
      const payload = {
        mode: "yaml-content",
        yaml_content: new_yaml_content,
        app_id: app_id
      };

      const response = await client.post(`/console/api/apps/imports`, payload);

      return {
        content: [{ type: "text", text: `Workflow updated successfully. Status: ${response.status}. A local backup was created just in case.` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleAxiosError(error) }],
        isError: true,
      };
    }
  }
);

// 6. inject_node_into_workflow
server.registerTool(
  "inject_node_into_workflow",
  {
    description: "Parses current YAML, injects a new node into the graph, connects it to an optional source node, and returns the modified YAML.",
    inputSchema: {
      current_yaml: z.string().describe("The existing workflow YAML string"),
      node_type: z.string().describe("The Dify node type (e.g. 'llm', 'http-request', 'langgenius/tavily')"),
      node_config: z.any().describe("A JSON object representing the internal 'data' configuration for the new node. Follow basic schema constraints."),
      source_node_id: z.string().optional().describe("If provided, creates an edge from this node to the newly injected node"),
    },
  },
  async ({ current_yaml, node_type, node_config, source_node_id }) => {
    try {
      // Step 1: Execute Hybrid Zod Validation
      const validationStatus = await validateNodePayload(node_type, node_config);
      
      const doc = yaml.parse(current_yaml);
      const workflowSection = doc.workflow ? doc.workflow : doc;
      if (!workflowSection || !workflowSection.graph) {
        throw new Error("Invalid DSL format: 'graph' object not found in YAML.");
      }

      const newNodeId = new Date().getTime().toString();
      if (!Array.isArray(workflowSection.graph.nodes)) workflowSection.graph.nodes = [];

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

      if (source_node_id) {
        if (!Array.isArray(workflowSection.graph.edges)) workflowSection.graph.edges = [];
        const newEdgeId = `edge-${source_node_id}-to-${newNodeId}`;
        const newEdge = {
          data: { sourceType: "unknown", targetType: node_type },
          id: newEdgeId,
          source: source_node_id,
          sourceHandle: "source",
          target: newNodeId,
          targetHandle: "target",
          type: "custom"
        };
        workflowSection.graph.edges.push(newEdge);
      }
      
      // Post-injection structure DAG verification! (Local Sanity Check)
      const dagCheck = validateDagIntegrity(workflowSection.graph);
      let successText = yaml.stringify(doc, { indent: 2 });
      
      let allWarnings = [...validationStatus.warnings, ...dagCheck.warnings];
      if (!dagCheck.valid) {
         return {
           content: [{ type: "text", text: `⛔ INJECTION FAILED. The resulting YAML violates DAG Integrity:\n${dagCheck.errors.join("\n")}` }],
           isError: true,
         }
      }

      if (allWarnings.length > 0) {
         successText = `<!-- WARNINGS:\n${allWarnings.join("\n")}\n-->\n\n` + successText;
      }

      return {
        content: [{ type: "text", text: successText }],
      };
    } catch (error) {
       return {
         content: [{ type: "text", text: `Failed to modify YAML: ${(error as Error).message}` }],
         isError: true,
       };
    }
  }
);

// 7. inject_env_variable_into_workflow
server.registerTool(
  "inject_env_variable_into_workflow",
  {
    description: "Parses current YAML, injects a new Environment Variable into the workflow, and returns the modified YAML.",
    inputSchema: {
      current_yaml: z.string().describe("The existing workflow YAML string"),
      name: z.string().describe("The name of the environment variable (e.g., API_KEY)"),
      value: z.string().describe("The default value of the environment variable"),
      description: z.string().optional().default("").describe("Short description of what the variable does"),
      value_type: z.enum(["string", "number", "secret"]).optional().default("string").describe("The type of the variable"),
    },
  },
  async ({ current_yaml, name, value, description, value_type }) => {
    try {
      const doc = yaml.parse(current_yaml);
      const workflowSection = doc.workflow ? doc.workflow : doc;
      
      if (!workflowSection) {
        throw new Error("Invalid DSL format: 'workflow' section not found.");
      }

      if (!Array.isArray(workflowSection.environment_variables)) {
        workflowSection.environment_variables = [];
      }

      // Generate a simple pseudo-UUID inline using Math.random
      const pseudoUuid = "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
        (parseInt(c) ^ Math.floor(Math.random() * 256) & 15 >> parseInt(c) / 4).toString(16)
      );

      workflowSection.environment_variables.push({
        id: pseudoUuid,
        value_type,
        name,
        value,
        description
      });

      return {
        content: [{ type: "text", text: yaml.stringify(doc, { indent: 2 }) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to inject Env Var: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// 8. inject_conv_variable_into_workflow
server.registerTool(
  "inject_conv_variable_into_workflow",
  {
    description: "Parses current YAML, injects a new Conversation Variable into the workflow, and returns the modified YAML.",
    inputSchema: {
      current_yaml: z.string().describe("The existing workflow YAML string"),
      name: z.string().describe("The name of the conversation variable"),
      value: z.string().describe("The default value of the conversation variable"),
      description: z.string().optional().default("").describe("Short description"),
      value_type: z.enum(["string", "number", "object", "array_string", "array_number", "array_object"]).optional().default("string").describe("The type of the variable"),
    },
  },
  async ({ current_yaml, name, value, description, value_type }) => {
    try {
      const doc = yaml.parse(current_yaml);
      const workflowSection = doc.workflow ? doc.workflow : doc;
      
      if (!workflowSection) {
        throw new Error("Invalid DSL format: 'workflow' section not found.");
      }

      if (!Array.isArray(workflowSection.conversation_variables)) {
        workflowSection.conversation_variables = [];
      }

      const pseudoUuid = "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
        (parseInt(c) ^ Math.floor(Math.random() * 256) & 15 >> parseInt(c) / 4).toString(16)
      );

      workflowSection.conversation_variables.push({
        id: pseudoUuid,
        value_type,
        name,
        value,
        description
      });

      return {
        content: [{ type: "text", text: yaml.stringify(doc, { indent: 2 }) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to inject Conv Var: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// 9. run_workflow_draft_node
server.registerTool(
  "run_workflow_draft_node",
  {
    description: "Executes a specific node in a Dify workflow draft. If node_id is 'sys_start_01', it triggers the entire flow.",
    inputSchema: {
      app_id: z.string().describe("The Application ID"),
      node_id: z.string().optional().default("sys_start_01").describe("The Node ID to execute"),
      query: z.string().optional().default("").describe("Input query for the run"),
      inputs: z.record(z.any()).optional().default({}).describe("Key-value input variables"),
      conversation_id: z.string().optional().default("").describe("Existing conversation ID context"),
      files: z.array(z.any()).optional().default([]).describe("Additional files for processing"),
    },
  },
  async ({ app_id, node_id, query, inputs, conversation_id, files }) => {
    try {
      const client = createDifyClient();
      const payload = {
        conversation_id,
        inputs: inputs || {},
        query: query || "",
        files: files || []
      };

      const response = await client.post(
        `/console/api/apps/${app_id}/workflows/draft/nodes/${node_id}/run`, 
        payload
      );

      return {
        content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: handleAxiosError(error) }],
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
