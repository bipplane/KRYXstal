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
  /** True when the server wakes the next participant round-robin (TURN_TAKING=on). */
  turnTaking: boolean;
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
          ") to read other channels, post elsewhere, or coordinate with other agents."
        : "- You have no channel tools; reply in prose only.",
      context.tools.includes("post_message")
        ? "- To tag or mention another agent, include @AgentName in your message content when using post_message. For example: `post_message({ channel: \"general\", content: \"@AgentB can you help with this?\" })`. The @ mention in the text will wake that agent."
        : "",
      "- Mentions: `@name` means \"I need a reply or an action from you\"; it wakes that agent and costs a run. Do not `@`mention when answering, acknowledging, or referring to an agent in the third person — write the plain name. Your answer is routed back to whoever asked you automatically.",
      "- If you asked another agent something, end your turn; you will be woken when it replies. Do not poll with `read_channel` waiting for an answer.",
      "- Once what was asked has been done, stop: reply briefly without mentions rather than continuing the exchange.",
      context.tools.includes("spawn_agent")
        ? "- `spawn_agent` creates a session under your identity with a subset of your permissions. Give it a clear task and a channel to report in; sessions cannot exceed what you can do."
        : "",
      context.tools.includes("request_principal")
        ? "- Only the human can create new long-lived agents. Use `request_principal` to ask; it posts an approval request in #approvals."
        : "",
      context.tools.includes("request_capability")
        ? "- If a task needs a capability your policy lacks (a denied command, network, a tool), call `request_capability` with the action and why, then end your turn. The human decides in your channel: allow once (your next turn), allow forever, or deny; you are woken with the decision."
        : "",
      context.tools.includes("publish_for_review")
        ? "- Developer handoff: call `publish_for_review` with every claimed source and test file, then post returned exact artifact ID to Reviewer. Never claim unpublished files were reviewed."
        : "",
      context.tools.includes("read_review_artifact")
        ? "- Reviewer handoff: call `read_review_artifact` with exact artifact ID supplied by Developer; omit `path` to inspect manifest, then read listed source/tests and independently inspect or run published tests."
        : "",
      !context.tools.includes("read_review_artifact") && context.tools.includes("request_capability")
        ? "- Reviewer handoff requiring approval: when Developer supplies an exact review artifact ID, call `request_capability` for action `artifact:read` and resource `artifact:<exact-id>`, explain the review need, then end your turn. If approved, your next run exposes `read_review_artifact`; list the manifest before reading exact files."
        : "",
      "",
      "## Working alongside other agents",
      "",
      "- Shared channels are contended: several of you may be woken by the same message and act at once. The server accepts a write only from an agent that has seen the whole channel, and at most one of you wins each step. Assume a teammate may be doing the same thing right now, and plan for it.",
      "- Losing a race is normal, not an error to work around. The feedback names who got there first and what they did: read the channel again" +
        (context.tools.includes("read_channel") ? " (`read_channel`)" : "") +
        ", update your plan from what they actually did, and only then contribute something new. Never repeat a rejected message.",
      context.turnTaking
        ? "- Take turns: after you contribute, the next collaborator is woken automatically; a plain reply is the handover. When the request is fully handled and you have nothing to add, reply exactly `[no reply]` — nothing is posted and nobody is woken."
        : "- Shared tasks move only when someone is woken. When you contribute a step to a group task, end your message with `@everyone` so the whole group is woken for the next step; expect several of you to attempt it and the server to accept one. When the request is fully handled and you have nothing to add, reply exactly `[no reply]` — nothing is posted and nobody is woken.",
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
