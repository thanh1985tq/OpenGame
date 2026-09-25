/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendCodexMcpConfig,
  getOpenGameMcpDefinition,
  mergeAgyMcpConfig,
  prepareAgyMcpConfig,
} from './mcpIntegration.js';

describe('external agent MCP integration', () => {
  it('adds a required, workspace-scoped stdio server to Codex arguments', () => {
    const definition = {
      command: '/usr/bin/node',
      args: ['/app/opengameToolsServerMain.js', '--workspace', '/game'],
      cwd: '/game',
    };
    const args = ['exec'];
    appendCodexMcpConfig(args, definition);

    expect(args).toContain(
      'mcp_servers.opengame_builtin.command="/usr/bin/node"',
    );
    expect(args).toContain(
      'mcp_servers.opengame_builtin.args=["/app/opengameToolsServerMain.js","--workspace","/game"]',
    );
    expect(args).toContain('mcp_servers.opengame_builtin.required=true');
  });

  it('merges the OpenGame server without removing existing Agy servers', () => {
    const definition = {
      command: '/usr/bin/node',
      args: ['/app/server.js', '--workspace', '/game'],
      cwd: '/game',
    };
    const merged = mergeAgyMcpConfig(
      { mcpServers: { existing: { serverUrl: 'https://example.test/mcp' } } },
      definition,
    );

    expect(merged.mcpServers).toEqual({
      existing: { serverUrl: 'https://example.test/mcp' },
      opengame_builtin: definition,
    });
  });

  it('resolves the bundled MCP entry point next to the CLI build', () => {
    const definition = getOpenGameMcpDefinition('/game', {
      moduleUrl: pathToFileURL('/app/agentRunners/mcpIntegration.js').href,
    });
    expect(definition.command).toBe(process.execPath);
    expect(definition.args[0]).toMatch(/opengameToolsServerMain\.js$/);
    expect(definition.args.slice(1)).toEqual(['--workspace', '/game']);
  });

  it('adds the provider tool switch only when explicitly requested', () => {
    const definition = getOpenGameMcpDefinition('/game', {
      providerTools: true,
      moduleUrl: pathToFileURL('/app/agentRunners/mcpIntegration.js').href,
    });
    expect(definition.args.slice(-3)).toEqual([
      '--workspace',
      '/game',
      '--provider-tools',
    ]);
  });

  it('restores an existing Agy MCP config after the run', async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opengame-agy-mcp-'),
    );
    const configDirectory = path.join(workspace, '.agents');
    const configPath = path.join(configDirectory, 'mcp_config.json');
    const original =
      '{\n  "mcpServers": { "existing": { "command": "x" } }\n}\n';
    await fs.mkdir(configDirectory);
    await fs.writeFile(configPath, original);

    try {
      const cleanup = await prepareAgyMcpConfig({
        command: '/usr/bin/node',
        args: ['/app/server.js'],
        cwd: workspace,
      });
      const active = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(active.mcpServers['existing']).toEqual({ command: 'x' });
      expect(active.mcpServers['opengame_builtin']).toBeDefined();

      await cleanup();
      expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
