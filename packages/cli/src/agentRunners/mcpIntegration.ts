/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_SERVER_NAME = 'opengame_builtin';

export interface StdioMcpDefinition {
  command: string;
  args: string[];
  cwd: string;
}

export interface OpenGameMcpDefinitionOptions {
  providerTools?: boolean;
  moduleUrl?: string;
}

interface AgyMcpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function getOpenGameMcpDefinition(
  cwd: string,
  options: OpenGameMcpDefinitionOptions = {},
): StdioMcpDefinition {
  const args = [
    fileURLToPath(
      new URL(
        '../mcp/opengameToolsServerMain.js',
        options.moduleUrl ?? import.meta.url,
      ),
    ),
    '--workspace',
    cwd,
  ];
  if (options.providerTools) {
    args.push('--provider-tools');
  }
  return {
    command: process.execPath,
    args,
    cwd,
  };
}

function tomlValue(value: unknown): string {
  return JSON.stringify(value);
}

export function appendCodexMcpConfig(
  args: string[],
  definition: StdioMcpDefinition,
): void {
  const prefix = `mcp_servers.${MCP_SERVER_NAME}`;
  args.push(
    '--config',
    `${prefix}.command=${tomlValue(definition.command)}`,
    '--config',
    `${prefix}.args=${tomlValue(definition.args)}`,
    '--config',
    `${prefix}.cwd=${tomlValue(definition.cwd)}`,
    '--config',
    `${prefix}.required=true`,
    '--config',
    `${prefix}.startup_timeout_sec=20`,
    '--config',
    `${prefix}.tool_timeout_sec=600`,
    '--config',
    `${prefix}.default_tools_approval_mode="approve"`,
  );
}

export function mergeAgyMcpConfig(
  config: AgyMcpConfig,
  definition: StdioMcpDefinition,
): AgyMcpConfig {
  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers ?? {}),
      [MCP_SERVER_NAME]: definition,
    },
  };
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function prepareAgyMcpConfig(
  definition: StdioMcpDefinition,
): Promise<() => Promise<void>> {
  const configDir = path.join(definition.cwd, '.agents');
  const configPath = path.join(configDir, 'mcp_config.json');
  const original = await readIfPresent(configPath);
  let parsed: AgyMcpConfig = {};
  if (original !== undefined) {
    try {
      parsed = JSON.parse(original) as AgyMcpConfig;
    } catch (error) {
      throw new Error(`Cannot merge invalid JSON in ${configPath}`, {
        cause: error,
      });
    }
  }

  const generated = `${JSON.stringify(
    mergeAgyMcpConfig(parsed, definition),
    null,
    2,
  )}\n`;
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, generated, 'utf8');

  let cleaned = false;
  return async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;

    const current = await readIfPresent(configPath);
    if (current !== generated) {
      return;
    }
    if (original !== undefined) {
      await fs.writeFile(configPath, original, 'utf8');
      return;
    }

    await fs.unlink(configPath);
    try {
      await fs.rmdir(configDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') {
        throw error;
      }
    }
  };
}
