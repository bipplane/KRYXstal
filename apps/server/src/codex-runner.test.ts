import { describe, expect, it } from "vitest";
import { buildCodexArgs, newParsedEvents, parseCodexEventLine } from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation with hook trust bypassed", () => {
    const args = buildCodexArgs(
      { prompt: "build a calculator", threadId: null, sandboxMode: "workspace-write" },
      "/tmp/workspace",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "--dangerously-bypass-hook-trust",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      { prompt: "add tests", threadId: "thread-123", sandboxMode: "read-only" },
      "/tmp/workspace",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
    expect(args).toContain("read-only");
  });

  it("extracts the session, final message, usage and tool events", () => {
    const seen: string[] = [];
    const parsed = newParsedEvents(null, (event) => seen.push(event.type));
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "ok",
          exit_code: 0,
          status: "completed",
        },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "launchpad",
          tool: "post_message",
          arguments: { channel: "general", content: "hi" },
          status: "completed",
        },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(parsed.events.map((event) => event.type)).toEqual([
      "command_execution",
      "mcp_tool_call",
    ]);
    expect(parsed.events[0]).toMatchObject({ id: "cmd-1", summary: "npm test", exitCode: 0 });
    expect(parsed.events[1]?.summary).toBe("launchpad.post_message");
    expect(seen).toEqual(["command_execution", "mcp_tool_call"]);
  });

  it("captures turn failures as errors", () => {
    const parsed = newParsedEvents(null);
    parseCodexEventLine(
      JSON.stringify({ type: "turn.failed", error: { message: "model unavailable" } }),
      parsed,
    );
    expect(parsed.errors).toEqual(["model unavailable"]);
  });
});
