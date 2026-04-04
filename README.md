# Dify MCP Server 🤖🔄

A high-performance Model Context Protocol (MCP) server for integrating **Dify's** Workflow DSL and Canvas Graph natively with LLMs, circumventing the platform's lack of a public DSL import API.

## 🛠 Features

- **DSL Extraction**: Pull complete YAML Application definitions directly from any Workspace via the Console API.
- **Node Injection**: Parse, manipulate, and programmatically inject new functional nodes (e.g., `http-request`, `llm`) into existing Dify workflows preserving edge connections.
- **Auto-Refresh Auth**: Operates fully on in-memory Session abstraction. Dify's background `__Host-refresh_token` ensures long-lived authentication, acting identically to an eternal web session.
- **Zero Disk Pollution**: Uses pure Environment Variables setup seamlessly compatible with MCP's `mcp_config.json` paradigm.

## 🔑 How to Get Your Authentication Cookies

Since Dify restricts console operations, you need to extract the exact `HttpOnly` security cookies directly from your browser to allow this MCP server to act on your behalf.

1. Log in to your [Dify Cloud](https://cloud.dify.ai) environment.
2. Press **F12** to open the Developer Tools.
3. Navigate to the **Application** tab.
4. On the left sidebar, expand `Storage > Cookies` and click `https://cloud.dify.ai`.
5. Look for the following 3 specific items in the table and double-click their **Value** column to copy:
   - `__Host-access_token`
   - `__Host-csrf_token`
   - `__Host-refresh_token`

---

## ⚙️ Configuration

To run this server with your locally installed tools or inside Claude Desktop, edit your `mcp_config.json`:

```json
{
  "mcpServers": {
    "dify": {
      "command": "node",
      "args": [
        "caminho/absoluto/para/dify-mcp/build/index.js"
      ],
      "env": {
        "DIFY_BASE_URL": "https://cloud.dify.ai",
        "DIFY_ACCESS_TOKEN": "eyJh...",
        "DIFY_CSRF_TOKEN": "eyJh...",
        "DIFY_REFRESH_TOKEN": "b6d9..."
      }
    }
  }
}
```

### Advanced Environment Variables

| Variable | Default Value | Description |
|----------|---------------|-------------|
| `DIFY_BASE_URL` | `https://cloud.dify.ai` | The root base domain of your workspace. Change if you are using Self-Hosted. |
| `DIFY_ACCESS_TOKEN` | - | The current valid `__Host-access_token`. |
| `DIFY_CSRF_TOKEN` | - | The current valid `__Host-csrf_token`. |
| `DIFY_REFRESH_TOKEN` | - | Crucial token used by the Axios Interceptor to automatically refresh expired access tokens ensuring eternal sessions. |

## 🧰 Available Tools

### 🔍 Discovery & Lifecycle
- `list_apps`: Fetches a paginated list of all applications and workflows in the workspace.
- `search_apps`: Searches for applications by keyword matching the name or description, returning filtered `app_id`s.
- `create_app`: Creates a new empty Application or Workflow directly into the Workspace.

### 📥 Extraction
- `get_workflow_dsl`: Downloads the entire Graph YAML definition of an application directly from the Dify platform database.

### 🧬 Manipulation (With Hybrid Validation)
- `inject_node_into_workflow`: A powerful local parser to securely attach and format new specific configuration blocks and layout positions for your nodes.
- `inject_env_variable_into_workflow`: Appends a new Environment Variable definition into your workflow's runtime settings mapping.
- `inject_conv_variable_into_workflow`: Appends a new Conversation Variable (session state variable) into your workflow.
  - **Zod Hybrid Validation:** Native built-in nodes are validated locally under `schemas.ts`, preventing frontend UI crashes. If a plugin schema falls out of date, the engine fails over gracefully to the Dify Marketplace API online, returning a `[WARNING FOR MAINTAINER]` back to your prompt natively so you know your code needs to be updated.
  - **DAG Validator:** Built-in Topologic Guard checking connection edge integrity. Rejects any ghost nodes or missing geometry metadata automatically.

### 🚀 Execution & Synchronization 
- `run_workflow_draft_node`: Executes a specific node in a Dify workflow draft. If node_id is 'sys_start_01', it triggers the entire flow.
- `update_workflow_dsl`: Pushes the YAML data back into the Dify `/imports` endpoint, bypassing browser interactions.

## 🧪 Development

### Build
```bash
pnpm run build
```

*Built on standard Typescript using Zod and Axios with robust 4xx Interceptor Fallbacks.*
