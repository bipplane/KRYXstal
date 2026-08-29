// Helpers for integration (external MCP server) tools as IAM actions: `mcp:<integration>:<tool>`.
import type { Effect, Integration, IntegrationTool, Statement } from "./types";

const MCP_PREFIX = "mcp:";

export function mcpAction(integrationName: string, tool: string): string {
  return MCP_PREFIX + integrationName + ":" + tool;
}

export function mcpAll(integrationName: string): string {
  return mcpAction(integrationName, "*");
}

export function isMcpAction(action: string): boolean {
  return action.startsWith(MCP_PREFIX);
}

/** Tiny glob matcher: `*` matches any run of characters (including none), everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + source + "$").test(value);
}

/** Integrations whose tools an agent could actually call: logged in, or auth-less with discovered tools. */
export function isUsableIntegration(integration: Integration): boolean {
  return integration.status === "connected" || (integration.auth === "none" && integration.tools.length > 0);
}

/** Does this statement apply to an mcp call (resource is always `*`)? */
function appliesToMcp(statement: Statement, action: string): boolean {
  return (
    statement.actions.some((pattern) => globMatch(pattern, action)) &&
    statement.resources.some((pattern) => globMatch(pattern, "*"))
  );
}

/** IAM evaluation for one tool: explicit deny wins, then allow, else no access. */
export function toolAccess(statements: Statement[], integration: Integration, tool: IntegrationTool): Effect | null {
  const action = mcpAction(integration.name, tool.name);
  let allowed = false;
  for (const statement of statements) {
    if (!appliesToMcp(statement, action)) continue;
    if (statement.effect === "deny") return "deny";
    allowed = true;
  }
  return allowed ? "allow" : null;
}
