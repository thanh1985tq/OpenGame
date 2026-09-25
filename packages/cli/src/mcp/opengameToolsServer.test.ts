/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOpenGameToolsServer,
  validateMcpToolArguments,
} from './opengameToolsServer.js';

describe('OpenGame tools MCP server', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it('uses only local tools by default and executes tilemap generation', async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'opengame-mcp-'),
    );
    temporaryDirectories.push(workspaceRoot);
    const server = createOpenGameToolsServer({ workspaceRoot });
    const client = new Client({ name: 'opengame-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['generate_tilemap']);

    const result = await client.callTool({
      name: 'generate_tilemap',
      arguments: {
        tileset_key: 'terrain',
        tile_size: 16,
        tileset_grid_size: 3,
        auto_tiling: false,
        map_key: 'level_1',
        layout_ascii: ['##', '##'],
        legend: { '#': 1 },
      },
    });

    expect(result.isError).not.toBe(true);
    await expect(
      fs.stat(path.join(workspaceRoot, 'public', 'assets', 'level_1.json')),
    ).resolves.toBeDefined();

    await client.close();
    await server.close();
  });

  it('exposes provider-backed tools only when requested', async () => {
    const server = createOpenGameToolsServer({
      workspaceRoot: process.cwd(),
      includeProviderTools: true,
    });
    const client = new Client({ name: 'opengame-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'classify_game_type',
      'generate_gdd',
      'generate_game_assets',
      'generate_tilemap',
    ]);

    await client.close();
    await server.close();
  });

  it('rejects output paths and generated filenames outside the workspace', () => {
    expect(
      validateMcpToolArguments(
        'generate_game_assets',
        { output_dir_name: '../outside', assets: [] },
        '/workspace',
      ),
    ).toBe('output_dir_name must stay inside the workspace');
    expect(
      validateMcpToolArguments(
        'generate_tilemap',
        { map_key: '../escape' },
        '/workspace',
      ),
    ).toBe('Invalid map key: ../escape');
    expect(
      validateMcpToolArguments(
        'generate_game_assets',
        {
          assets: [
            {
              key: 'hero',
              animations: [{ name: '../escape' }],
            },
          ],
        },
        '/workspace',
      ),
    ).toBe('Invalid animation name: ../escape');
  });
});
