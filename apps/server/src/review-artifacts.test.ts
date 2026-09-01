import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { presetPolicy } from "./policy.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunIdentity, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [];
const runner: AgentRunner = {
  run: async (_request: RunnerRequest): Promise<RunnerResult> => ({ output: "ok", threadId: null, usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});

async function setup(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-artifacts-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex-home"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "test-model",
    ...env,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(config.dataDirectory, "launchpad.json")),
    new WorkspaceManager(config.workspaceRoot),
    runner,
  );
  await service.initialize();
  return { root, config, service };
}

const identity = (agentId: string, runId: string): RunIdentity => ({
  agentId,
  runId,
  expiresAt: Date.now() + 60_000,
});

describe("review artifact handoff", () => {
  it("publishes, lists, and reads exact verified content across isolated agents", async () => {
    const { config, service } = await setup();
    const developer = await service.createAgent({ name: "Developer" });
    const reviewer = await service.createAgent({
      name: "Reviewer",
      policy: {
        preset: "custom",
        statements: [{ effect: "allow", actions: ["artifact:read"], resources: ["artifact:*"] }],
        delegable: [],
      },
    });
    await mkdir(path.join(developer.workspacePath, "src"), { recursive: true });
    await writeFile(path.join(developer.workspacePath, "src", "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n");
    await writeFile(path.join(developer.workspacePath, "sum.test.ts"), "expect(sum(1, 2)).toBe(3);\n");

    const manifest = await service.agentPublishForReview(identity(developer.id, "run-dev"), {
      paths: ["src/sum.ts", "sum.test.ts"],
      note: "Source and claimed test",
    });
    expect(path.dirname(path.join(config.dataDirectory, "review-artifacts", manifest.artifactId))).not.toBe(config.workspaceRoot);
    expect(manifest).toMatchObject({
      publisherAgentId: developer.id,
      publisherRunId: "run-dev",
      paths: ["src/sum.ts", "sum.test.ts"],
      note: "Source and claimed test",
    });
    const listing = await service.agentReadReviewArtifact(identity(reviewer.id, "run-review"), manifest.artifactId);
    expect(listing).toEqual({ manifest });
    const read = await service.agentReadReviewArtifact(
      identity(reviewer.id, "run-review"),
      manifest.artifactId,
      "src/sum.ts",
    );
    const content = "export const sum = (a: number, b: number) => a + b;\n";
    expect(read).toMatchObject({
      path: "src/sum.ts",
      encoding: "utf8",
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(developer.workspacePath).not.toBe(reviewer.workspacePath);
    expect(service.getDecisions(developer.id)[0]).toMatchObject({ action: "artifact:publish", effect: "allow" });
    expect(service.getDecisions(reviewer.id)[0]).toMatchObject({ action: "artifact:read", effect: "allow" });
  });

  it("rejects absolute paths, traversal, missing files, directories, sensitive files, and symlinks", async () => {
    const { service, root } = await setup();
    const developer = await service.createAgent({ name: "Developer" });
    const id = identity(developer.id, "run-dev");
    await writeFile(path.join(developer.workspacePath, ".env"), "SECRET=x\n");
    await mkdir(path.join(developer.workspacePath, "folder"));
    await writeFile(path.join(root, "outside.txt"), "outside");
    await expect(service.agentPublishForReview(id, { paths: [path.join(root, "outside.txt")] })).rejects.toThrow("Absolute");
    await expect(service.agentPublishForReview(id, { paths: ["../outside.txt"] })).rejects.toThrow("traversal");
    await expect(service.agentPublishForReview(id, { paths: ["missing.txt"] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.agentPublishForReview(id, { paths: ["folder"] })).rejects.toThrow("regular files");
    await expect(service.agentPublishForReview(id, { paths: [".env"] })).rejects.toThrow("Sensitive");
    const link = path.join(developer.workspacePath, "link.txt");
    try {
      await symlink(path.join(root, "outside.txt"), link, "file");
      await expect(service.agentPublishForReview(id, { paths: ["link.txt"] })).rejects.toThrow("Symlinks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  it("enforces file-count, total-byte, and response-byte limits", async () => {
    const { service } = await setup({
      REVIEW_ARTIFACT_MAX_FILES: "1",
      REVIEW_ARTIFACT_MAX_TOTAL_BYTES: "4",
      REVIEW_ARTIFACT_MAX_RESPONSE_BYTES: "3",
    });
    const developer = await service.createAgent({ name: "Developer" });
    const reviewer = await service.createAgent({
      name: "Reviewer",
      policy: {
        preset: "custom",
        statements: [{ effect: "allow", actions: ["artifact:read"], resources: ["artifact:*"] }],
        delegable: [],
      },
    });
    await writeFile(path.join(developer.workspacePath, "a.txt"), "1234");
    await writeFile(path.join(developer.workspacePath, "b.txt"), "5");
    const dev = identity(developer.id, "dev");
    await expect(service.agentPublishForReview(dev, { paths: ["a.txt", "b.txt"] })).rejects.toThrow("file-count");
    await expect(service.agentPublishForReview(dev, { paths: ["a.txt"] })).resolves.toBeDefined();
    await writeFile(path.join(developer.workspacePath, "a.txt"), "12345");
    await expect(service.agentPublishForReview(dev, { paths: ["a.txt"] })).rejects.toThrow("total-byte");
    await writeFile(path.join(developer.workspacePath, "a.txt"), "1234");
    const artifact = await service.agentPublishForReview(dev, { paths: ["a.txt"] });
    await expect(service.agentReadReviewArtifact(identity(reviewer.id, "review"), artifact.artifactId, "a.txt"))
      .rejects.toThrow("response-size");
  });

  it("denies unauthorised publish and read", async () => {
    const { service } = await setup();
    const reviewer = await service.createAgent({ name: "Reviewer", policy: presetPolicy("reader") });
    const developer = await service.createAgent({ name: "Developer" });
    await writeFile(path.join(reviewer.workspacePath, "review.txt"), "x");
    await expect(service.agentPublishForReview(identity(reviewer.id, "r"), { paths: ["review.txt"] }))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(service.agentReadReviewArtifact(identity(developer.id, "d"), "00000000-0000-4000-8000-000000000000"))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(service.getDecisions(reviewer.id)[0]).toMatchObject({ action: "artifact:publish", effect: "deny" });
    expect(service.getDecisions(developer.id)[0]).toMatchObject({ action: "artifact:read", effect: "deny" });
  });

  it("keeps artifacts immutable, blocks unlisted files, and detects hash tampering", async () => {
    const { config, service } = await setup();
    const developer = await service.createAgent({ name: "Developer" });
    const reviewer = await service.createAgent({
      name: "Reviewer",
      policy: {
        preset: "custom",
        statements: [{ effect: "allow", actions: ["artifact:read"], resources: ["artifact:*"] }],
        delegable: [],
      },
    });
    await writeFile(path.join(developer.workspacePath, "listed.txt"), "original");
    await writeFile(path.join(developer.workspacePath, "unlisted.txt"), "private");
    const artifact = await service.agentPublishForReview(identity(developer.id, "dev"), { paths: ["listed.txt"] });
    await writeFile(path.join(developer.workspacePath, "listed.txt"), "changed");
    const read = await service.agentReadReviewArtifact(identity(reviewer.id, "review"), artifact.artifactId, "listed.txt");
    expect(read.content).toBe("original");
    await expect(service.agentReadReviewArtifact(identity(reviewer.id, "review"), artifact.artifactId, "unlisted.txt"))
      .rejects.toMatchObject({ statusCode: 404 });

    const stored = path.join(config.dataDirectory, "review-artifacts", artifact.artifactId, "files", "listed.txt");
    await chmod(stored, 0o600);
    await writeFile(stored, "tampered");
    await expect(service.agentReadReviewArtifact(identity(reviewer.id, "review"), artifact.artifactId, "listed.txt"))
      .rejects.toThrow("hash verification");
    const diskManifest = JSON.parse(await readFile(path.join(config.dataDirectory, "review-artifacts", artifact.artifactId, "manifest.json"), "utf8"));
    expect(diskManifest.artifactId).toBe(artifact.artifactId);
  });
});
