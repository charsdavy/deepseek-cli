// Workspace restriction mode: limits file-system tools to operate only
// within a declared workspace root. Inspired by codex's sandbox_policy
// (read-only / workspace-write / danger-full-access).
//
// Modes:
//   - "off"       → no restrictions (default, backward compatible)
//   - "workspace" → write_file + edit_file + bash writes limited to project root
//   - "readonly"  → only read tools allowed (no write_file, edit_file, or bash)

import * as path from "node:path";
import { log } from "../log/logger.ts";

export type WorkspaceMode = "off" | "workspace" | "readonly";

export interface WorkspaceConfig {
  mode: WorkspaceMode;
  /** Root directory for workspace (absolute path). */
  root?: string;
}

const DEFAULT_CONFIG: WorkspaceConfig = { mode: "off" };

export function loadWorkspaceConfig(cwd: string): WorkspaceConfig {
  const envMode = process.env.DEEPSEEK_WORKSPACE_MODE;
  if (envMode === "workspace") return { mode: "workspace", root: cwd };
  if (envMode === "readonly") return { mode: "readonly", root: cwd };
  return { ...DEFAULT_CONFIG };
}

/**
 * Check if a file path is within the workspace root.
 * Returns { allowed, reason } for PreToolUse-style feedback.
 */
export function checkPath(
  filePath: string,
  config: WorkspaceConfig,
): { allowed: boolean; reason?: string } {
  if (config.mode === "off" || !config.root) return { allowed: true };

  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(config.root, filePath);
  const normalizedRoot = path.resolve(config.root) + path.sep;

  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(config.root)) {
    log.warn("workspace: path outside root blocked", {
      path: filePath,
      resolved,
      root: config.root,
    });
    return {
      allowed: false,
      reason: `Path '${filePath}' is outside the workspace root '${config.root}'. Workspace mode limits file operations to the project directory.`,
    };
  }
  return { allowed: true };
}

/**
 * Check if a tool is allowed under the current workspace mode.
 */
export function checkTool(
  toolName: string,
  toolCategory: string,
  config: WorkspaceConfig,
): { allowed: boolean; reason?: string } {
  if (config.mode === "off") return { allowed: true };
  if (config.mode === "readonly") {
    if (toolCategory === "fs-write" || toolCategory === "bash") {
      return {
        allowed: false,
        reason: `Tool '${toolName}' is blocked in read-only workspace mode.`,
      };
    }
  }
  return { allowed: true };
}
