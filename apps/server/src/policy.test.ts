import { describe, expect, it } from "vitest";
import {
  deriveSessionPolicy,
  evaluate,
  grantChannels,
  grantOverride,
  mapToolCall,
  matchResource,
  mayEver,
  mayEverPrefix,
  presetPolicy,
  renderExecPolicyRules,
} from "./policy.js";
import type { Policy } from "./types.js";

describe("IAM evaluation", () => {
  it("applies explicit deny over allow and implicit deny otherwise", () => {
    const policy = presetPolicy("worker");
    expect(evaluate(policy, "shell:exec", "cmd:npm test").effect).toBe("allow");
    expect(evaluate(policy, "shell:exec", "cmd:rm -rf /tmp/x").effect).toBe("deny");
    expect(evaluate(policy, "net:access", "web").effect).toBe("deny");
    expect(evaluate(policy, "channel:post", "channel:general").effect).toBe("allow");
    expect(evaluate(presetPolicy("reader"), "channel:post", "channel:general").effect).toBe("deny");
    expect(evaluate(presetPolicy("reader"), "artifact:read", "artifact:any-id").effect).toBe("deny");
    expect(evaluate(presetPolicy("custom"), "channel:read", "channel:general")).toMatchObject({
      effect: "deny",
      reason: expect.stringContaining("No statement"),
    });
  });

  it("matches command resources by argv prefix", () => {
    expect(matchResource("cmd:rm -rf", "cmd:rm -rf /")).toBe(true);
    expect(matchResource("cmd:rm -rf", "cmd:rm -r /")).toBe(false);
    expect(matchResource("cmd:git push", "cmd:git push origin main")).toBe(true);
    expect(matchResource("cmd:git *", "cmd:git status")).toBe(true);
    expect(matchResource("cmd:*", "cmd:anything at all")).toBe(true);
    expect(matchResource("channel:*", "channel:general")).toBe(true);
    expect(matchResource("channel:gen*", "channel:deploys")).toBe(false);
  });

  it("reports which tools an agent may ever use", () => {
    expect(mayEver(presetPolicy("worker"), "agent:spawn")).toBe(true);
    expect(mayEver(presetPolicy("reader"), "channel:post")).toBe(false);
    expect(mayEver(presetPolicy("worker"), "net:access")).toBe(false);
    expect(mayEver(presetPolicy("admin"), "anything:else")).toBe(true);
  });

  it("adds channel grants only when missing", () => {
    const policy = grantChannels(presetPolicy("reader"), ["deploys"]);
    expect(evaluate(policy, "channel:post", "channel:deploys").effect).toBe("allow");
    expect(evaluate(policy, "channel:post", "channel:general").effect).toBe("deny");
    const worker = grantChannels(presetPolicy("worker"), ["deploys"]);
    expect(worker.statements).toHaveLength(presetPolicy("worker").statements.length);
  });
});

describe("Delegation", () => {
  it("derives a narrower session policy and inherits parent denies", () => {
    const result = deriveSessionPolicy(presetPolicy("worker"), {
      actions: ["shell:exec", "fs:write"],
      channelNames: ["build"],
      delegable: ["shell:exec"],
    });
    expect(result.ok).toBe(true);
    const policy = result.policy as Policy;
    expect(evaluate(policy, "shell:exec", "cmd:npm test").effect).toBe("allow");
    expect(evaluate(policy, "shell:exec", "cmd:rm -rf /").effect).toBe("deny");
    expect(evaluate(policy, "channel:post", "channel:build").effect).toBe("allow");
    expect(evaluate(policy, "channel:post", "channel:general").effect).toBe("deny");
    expect(evaluate(policy, "agent:spawn", "*").effect).toBe("deny");
    expect(policy.delegable).toEqual(["shell:exec"]);
  });

  it("refuses actions outside the parent's delegable set or holdings", () => {
    expect(
      deriveSessionPolicy(presetPolicy("worker"), { actions: ["net:access"], channelNames: [] }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("not delegable") });
    expect(
      deriveSessionPolicy(presetPolicy("worker"), { actions: ["agent:spawn"], channelNames: [] }),
    ).toMatchObject({ ok: false });
    const custom: Policy = {
      preset: "custom",
      statements: [{ effect: "allow", actions: ["channel:read"], resources: ["channel:a"] }],
      delegable: ["channel:*"],
    };
    expect(deriveSessionPolicy(custom, { actions: [], channelNames: ["b"] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("channel:b"),
    });
    expect(deriveSessionPolicy(custom, { actions: [], channelNames: ["a"] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("channel:post"),
    });
  });
});

describe("Human grants override denies", () => {
  it("lifts the matching deny and appends the allow", () => {
    const worker = presetPolicy("worker");
    const net = grantOverride(worker, "net:access", "*");
    expect(evaluate(net, "net:access", "web").effect).toBe("allow");
    expect(net.preset).toBe("custom");
    const push = grantOverride(worker, "shell:exec", "cmd:git push");
    expect(evaluate(push, "shell:exec", "cmd:git push origin main").effect).toBe("allow");
    expect(evaluate(push, "shell:exec", "cmd:rm -rf /").effect).toBe("deny");
    expect(evaluate(push, "shell:exec", "cmd:sudo ls").effect).toBe("deny");
  });
});

describe("Codex rule rendering", () => {
  it("emits a forbidden prefix_rule for every cmd deny", () => {
    const rules = renderExecPolicyRules(presetPolicy("worker"));
    expect(rules).toContain('prefix_rule(pattern=["rm","-rf"], decision="forbidden"');
    expect(rules).toContain('prefix_rule(pattern=["git","push"], decision="forbidden"');
    expect(rules).not.toContain("allow");
  });
});

describe("Tool call mapping", () => {
  it("maps shell, patch, and launchpad MCP calls to IAM actions", () => {
    expect(mapToolCall("Bash", { command: "rm -rf /tmp" })).toEqual({
      action: "shell:exec",
      resource: "cmd:rm -rf /tmp",
    });
    expect(mapToolCall("shell", { command: ["npm", "test"] })).toEqual({
      action: "shell:exec",
      resource: "cmd:npm test",
    });
    expect(mapToolCall("apply_patch", {})).toEqual({ action: "fs:write", resource: "workspace" });
    expect(mapToolCall("mcp__launchpad__post_message", { channel: "deploys" })).toEqual({
      action: "channel:post",
      resource: "channel:deploys",
    });
    expect(mapToolCall("mcp__launchpad__spawn_agent", {})).toEqual({
      action: "agent:spawn",
      resource: "*",
    });
    expect(mapToolCall("mcp__launchpad__publish_for_review", { paths: ["src/a.ts"] })).toEqual({
      action: "artifact:publish",
      resource: "artifact:*",
    });
    expect(mapToolCall("mcp__launchpad__read_review_artifact", { artifact_id: "artifact-id" })).toEqual({
      action: "artifact:read",
      resource: "artifact:artifact-id",
    });
    expect(mapToolCall("update_plan", {})).toBeNull();
    expect(mapToolCall("mcp__linear__create_issue", { title: "x" })).toEqual({
      action: "mcp:linear:create_issue",
      resource: "*",
    });
    expect(mapToolCall("view_image", {})).toBeNull();
  });

  it("knows whether a policy could ever reach an MCP server", () => {
    const grant = (actions: string[]): Policy => ({
      preset: "custom",
      statements: [{ effect: "allow", actions, resources: ["*"] }],
      delegable: [],
    });
    expect(mayEverPrefix(grant(["mcp:linear:*"]), "mcp:linear:")).toBe(true);
    expect(mayEverPrefix(grant(["mcp:linear:list_issues"]), "mcp:linear:")).toBe(true);
    expect(mayEverPrefix(grant(["mcp:*"]), "mcp:linear:")).toBe(true);
    expect(mayEverPrefix(grant(["*"]), "mcp:linear:")).toBe(true);
    expect(mayEverPrefix(grant(["mcp:github:*"]), "mcp:linear:")).toBe(false);
    expect(mayEverPrefix(presetPolicy("worker"), "mcp:linear:")).toBe(false);
    expect(mayEverPrefix(presetPolicy("admin"), "mcp:linear:")).toBe(true);
    const linearAllowed = grant(["mcp:linear:*"]);
    expect(evaluate(linearAllowed, "mcp:linear:create_issue", "*").effect).toBe("allow");
    expect(evaluate(linearAllowed, "mcp:github:create_issue", "*").effect).toBe("deny");
  });
});
