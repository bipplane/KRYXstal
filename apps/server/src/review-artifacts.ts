import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { ReviewArtifactFile, ReviewArtifactManifest } from "./types.js";

const MANIFEST_FILE = "manifest.json";
const FILES_DIRECTORY = "files";
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** Accept portable relative paths only and store them with `/` separators. */
export function safeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new HttpError(400, "Artifact path must be a non-empty relative path");
  }
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
    throw new HttpError(400, "Absolute artifact paths are not allowed");
  }
  const segments = input.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new HttpError(400, "Artifact path traversal is not allowed");
  }
  return segments.join("/");
}

export function isSensitiveReviewPath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split("/");
  const base = segments.at(-1) ?? "";
  if (segments.some((segment) => [".codex", "codex-home", "logs", "oauth", ".ssh"].includes(segment))) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (/^(auth|credentials?|tokens?|secrets?)(\.[a-z0-9_-]+)*$/.test(base)) return true;
  if ([".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519"].includes(base)) return true;
  if (/\.(log|pem|key|p12|pfx|sqlite(?:-shm|-wal)?)$/.test(base)) return true;
  return false;
}

async function assertNoSymlink(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(404, "Artifact file does not exist: " + relativePath);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) throw new HttpError(400, "Symlinks are not allowed: " + relativePath);
  }
}

async function readRegularFile(
  root: string,
  relativePath: string,
  maxBytes?: number,
  limitMessage = "File exceeds allowed byte limit",
): Promise<Buffer> {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new HttpError(400, "Artifact root must be a real directory");
  }
  await assertNoSymlink(root, relativePath);
  const candidate = path.join(root, ...relativePath.split("/"));
  const resolvedRoot = await realpath(root);
  const resolvedBefore = await realpath(candidate);
  if (!isInside(resolvedRoot, resolvedBefore)) throw new HttpError(400, "Artifact path escapes its root");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new HttpError(400, "Symlinks are not allowed: " + relativePath);
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new HttpError(400, "Only regular files may be published: " + relativePath);
    if (maxBytes !== undefined && opened.size > maxBytes) throw new HttpError(413, limitMessage);
    const content = await handle.readFile();
    if (maxBytes !== undefined && content.byteLength > maxBytes) throw new HttpError(413, limitMessage);
    const resolvedAfter = await realpath(candidate);
    const after = await lstat(candidate);
    if (
      resolvedAfter !== resolvedBefore ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      (opened.ino !== 0 && after.ino !== 0 && (opened.ino !== after.ino || opened.dev !== after.dev))
    ) {
      throw new HttpError(409, "Artifact source changed while being read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export class ReviewArtifactStorage {
  readonly root: string;

  constructor(private readonly config: AppConfig) {
    this.root = path.join(config.dataDirectory, "review-artifacts");
  }

  async initialize(): Promise<void> {
    if (isInside(this.config.workspaceRoot, this.root)) {
      throw new Error("Review artifact storage must be outside AGENT_WORKSPACE_ROOT");
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async publish(input: {
    workspacePath: string;
    agentId: string;
    runId: string;
    traceId: string | null;
    paths: string[];
    note?: string | undefined;
  }): Promise<ReviewArtifactManifest> {
    if (input.paths.length === 0) throw new HttpError(400, "At least one path is required");
    if (input.paths.length > this.config.reviewArtifactMaxFiles) {
      throw new HttpError(413, "Review artifact file-count limit exceeded");
    }
    const paths = input.paths.map(safeRelativePath);
    if (new Set(paths).size !== paths.length) throw new HttpError(400, "Duplicate artifact paths are not allowed");
    for (const relativePath of paths) {
      if (isSensitiveReviewPath(relativePath)) {
        throw new HttpError(400, "Sensitive file may not be published: " + relativePath);
      }
    }

    const workspace = await realpath(input.workspacePath);
    const buffers = new Map<string, Buffer>();
    const files: ReviewArtifactFile[] = [];
    let totalBytes = 0;
    for (const relativePath of paths) {
      const content = await readRegularFile(
        workspace,
        relativePath,
        this.config.reviewArtifactMaxTotalBytes - totalBytes,
        "Review artifact total-byte limit exceeded",
      );
      totalBytes += content.byteLength;
      if (totalBytes > this.config.reviewArtifactMaxTotalBytes) {
        throw new HttpError(413, "Review artifact total-byte limit exceeded");
      }
      buffers.set(relativePath, content);
      files.push({ path: relativePath, size: content.byteLength, sha256: sha256(content) });
    }

    const artifactId = randomUUID();
    const manifest: ReviewArtifactManifest = {
      artifactId,
      publisherAgentId: input.agentId,
      publisherRunId: input.runId,
      publisherTraceId: input.traceId,
      paths,
      files,
      note: input.note?.trim() || null,
      createdAt: new Date().toISOString(),
    };
    const staging = path.join(this.root, ".tmp-" + artifactId);
    const destination = path.join(this.root, artifactId);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      for (const file of files) {
        const target = path.join(staging, FILES_DIRECTORY, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, buffers.get(file.path) as Buffer, { flag: "wx", mode: 0o400 });
      }
      await writeFile(path.join(staging, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", {
        flag: "wx",
        mode: 0o400,
      });
      const directories = new Set<string>([staging, path.join(staging, FILES_DIRECTORY)]);
      for (const file of files) {
        let directory = path.dirname(path.join(staging, FILES_DIRECTORY, ...file.path.split("/")));
        while (isInside(staging, directory)) {
          directories.add(directory);
          if (directory === staging) break;
          directory = path.dirname(directory);
        }
      }
      await rename(staging, destination);
      for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
        await chmod(destination + directory.slice(staging.length), 0o500).catch(() => undefined);
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return manifest;
  }

  async read(manifest: ReviewArtifactManifest, requestedPath?: string | undefined): Promise<Record<string, unknown>> {
    if (!ARTIFACT_ID.test(manifest.artifactId)) throw new HttpError(400, "Invalid artifact ID");
    const artifactRoot = path.join(this.root, manifest.artifactId);
    await assertNoSymlink(this.root, manifest.artifactId);
    const diskManifest = await readRegularFile(artifactRoot, MANIFEST_FILE);
    let parsed: unknown;
    try {
      parsed = JSON.parse(diskManifest.toString("utf8"));
    } catch {
      throw new HttpError(409, "Review artifact manifest is corrupt");
    }
    if (JSON.stringify(parsed) !== JSON.stringify(manifest)) {
      throw new HttpError(409, "Review artifact manifest does not match stored metadata");
    }
    if (requestedPath === undefined) {
      const result = { manifest };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > this.config.reviewArtifactMaxResponseBytes) {
        throw new HttpError(413, "Review artifact response-size limit exceeded");
      }
      return result;
    }
    const relativePath = safeRelativePath(requestedPath);
    const entry = manifest.files.find((file) => file.path === relativePath);
    if (!entry) throw new HttpError(404, "File was not published in this artifact");
    if (entry.size > this.config.reviewArtifactMaxResponseBytes) {
      throw new HttpError(413, "Review artifact response-size limit exceeded");
    }
    const content = await readRegularFile(path.join(artifactRoot, FILES_DIRECTORY), relativePath);
    if (content.byteLength !== entry.size || sha256(content) !== entry.sha256) {
      throw new HttpError(409, "Review artifact hash verification failed");
    }
    try {
      const result = { artifactId: manifest.artifactId, path: relativePath, size: entry.size, sha256: entry.sha256, encoding: "utf8", content: utf8.decode(content) };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > this.config.reviewArtifactMaxResponseBytes) {
        throw new HttpError(413, "Review artifact response-size limit exceeded");
      }
      return result;
    } catch {
      const result = { artifactId: manifest.artifactId, path: relativePath, size: entry.size, sha256: entry.sha256, encoding: "base64", content: content.toString("base64") };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > this.config.reviewArtifactMaxResponseBytes) {
        throw new HttpError(413, "Review artifact response-size limit exceeded");
      }
      return result;
    }
  }
}
