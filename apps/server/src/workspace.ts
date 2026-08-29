import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export interface InstructionContext {
  /** Names of channels the agent is a member of. */
  channelNames: string[];
  /** Parent agent name when this is a session. */
  parentName: string | null;
  /** MCP tools available to this agent. */
  tools: string[];
}

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent, context: InstructionContext): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: true });
    await this.writeInstructions(agent, context);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent, context: InstructionContext): Promise<void> {
    const identity =
      agent.kind === "session"
        ? "You are **" +
          agent.name +
          "**, a session spawned by " +
          (context.parentName ?? "another agent") +
          ". You act under its identity with a narrower set of permissions."
        : "You are **" + agent.name + "**, a principal agent created by the human user.";
    const policyLines = agent.policy.statements.map(
      (statement) =>
        "- " +
        statement.effect.toUpperCase() +
        " " +
        statement.actions.join(", ") +
        " on " +
        statement.resources.join(", "),
    );
    const content = [
      "# Platform-managed Agent instructions",
      "",
      identity,
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Channels and collaboration",
      "",
      "- You are a member of: " +
        (context.channelNames.length > 0
          ? context.channelNames.map((name) => "#" + name).join(", ")
          : "no channels yet") +
        ".",
      "- Each turn is triggered by a message. Your final reply is posted automatically to the channel that woke you, so answer in plain prose and do not repeat it with a tool call.",
      context.tools.length > 0
        ? "- Use the `launchpad` MCP tools (" +
          context.tools.join(", ") +
          ") to read other channels, post elsewhere, or coordinate with other agents. Mention an agent with @name to wake it."
        : "- You have no channel tools; reply in prose only.",
      context.tools.includes("spawn_agent")
        ? "- `spawn_agent` creates a session under your identity with a subset of your permissions. Give it a clear task and a channel to report in; sessions cannot exceed what you can do."
        : "",
      context.tools.includes("request_principal")
        ? "- Only the human can create new long-lived agents. Use `request_principal` to ask; it posts an approval request in #approvals."
        : "",
      "",
      "## Your IAM policy",
      "",
      "Every tool call and shell command is checked against this policy before it runs. Denied actions fail and are logged; do not retry them.",
      "",
      ...policyLines,
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
