/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  GameTypeClassifierTool,
  GenerateAssetsTool,
  GenerateGDDTool,
  GenerateTilemapTool,
  type AnyDeclarativeTool,
  type OpenGameProvidersSettings,
  type ToolResult,
} from '@opengame/opengame-core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';

const SERVER_INSTRUCTIONS =
  'For game creation, call classify_game_type first, then generate_gdd. Save the returned GDD as GAME_DESIGN.md. Use generate_game_assets for the GDD asset registry and generate_tilemap only for map-based archetypes. If a provider is not configured, continue with agent-authored design or code-native assets.';

const READ_ONLY_TOOLS = new Set(['classify_game_type', 'generate_gdd']);
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface OpenGameToolsServerOptions {
  workspaceRoot: string;
  providers?: OpenGameProvidersSettings;
  includeProviderTools?: boolean;
}

function createConfig(options: OpenGameToolsServerOptions): Config {
  return new Config({
    targetDir: options.workspaceRoot,
    cwd: options.workspaceRoot,
    debugMode: false,
    telemetry: { enabled: false },
    usageStatisticsEnabled: false,
    openGameProviders: options.providers,
  });
}

export function createOpenGameToolSet(
  options: OpenGameToolsServerOptions,
): AnyDeclarativeTool[] {
  const config = createConfig(options);
  const tools = [
    new GameTypeClassifierTool(config),
    new GenerateGDDTool(config),
    new GenerateAssetsTool(config),
    new GenerateTilemapTool(config),
  ] as unknown as AnyDeclarativeTool[];
  return options.includeProviderTools
    ? tools
    : tools.filter((tool) => tool.name === 'generate_tilemap');
}

function stringifyPart(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stringifyPart).filter(Boolean).join('\n');
  }
  if (typeof value === 'object' && value !== null) {
    const text = (value as Record<string, unknown>)['text'];
    if (typeof text === 'string') {
      return text;
    }
  }
  return JSON.stringify(value);
}

export function toolResultToText(result: ToolResult): string {
  const content = stringifyPart(result.llmContent);
  if (content) {
    return content;
  }
  return stringifyPart(result.returnDisplay);
}

function isSafeRelativePath(workspaceRoot: string, value: string): boolean {
  if (path.isAbsolute(value)) {
    return false;
  }
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function validateMcpToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): string | undefined {
  if (
    typeof args['output_dir_name'] === 'string' &&
    !isSafeRelativePath(workspaceRoot, args['output_dir_name'])
  ) {
    return 'output_dir_name must stay inside the workspace';
  }

  if (toolName === 'generate_game_assets' && Array.isArray(args['assets'])) {
    for (const asset of args['assets']) {
      if (typeof asset !== 'object' || asset === null) {
        continue;
      }
      const assetRecord = asset as Record<string, unknown>;
      const key = assetRecord['key'];
      if (typeof key === 'string' && !SAFE_KEY.test(key)) {
        return `Invalid asset key: ${key}`;
      }
      if (Array.isArray(assetRecord['animations'])) {
        for (const animation of assetRecord['animations']) {
          const name =
            typeof animation === 'object' && animation !== null
              ? (animation as Record<string, unknown>)['name']
              : undefined;
          if (typeof name === 'string' && !SAFE_KEY.test(name)) {
            return `Invalid animation name: ${name}`;
          }
        }
      }
    }
  }

  if (toolName === 'generate_tilemap') {
    const mapKeys: unknown[] = [];
    if (args['map_key'] !== undefined) {
      mapKeys.push(args['map_key']);
    }
    if (Array.isArray(args['maps'])) {
      for (const map of args['maps']) {
        if (typeof map === 'object' && map !== null) {
          mapKeys.push((map as Record<string, unknown>)['map_key']);
        }
      }
    }
    for (const key of mapKeys) {
      if (typeof key === 'string' && !SAFE_KEY.test(key)) {
        return `Invalid map key: ${key}`;
      }
    }
  }

  return undefined;
}

export function createOpenGameToolsServer(
  options: OpenGameToolsServerOptions,
): Server {
  const tools = createOpenGameToolSet(options);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: 'opengame-tools', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: options.includeProviderTools
        ? SERVER_INSTRUCTIONS
        : 'The agent handles game classification, GDD, and visual assets directly. Use generate_tilemap only for map-based game archetypes.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(
      (tool): Tool => ({
        name: tool.name,
        title: tool.displayName,
        description: tool.description,
        inputSchema: tool.schema.parametersJsonSchema as Tool['inputSchema'],
        annotations: {
          readOnlyHint: READ_ONLY_TOOLS.has(tool.name),
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: tool.name === 'generate_game_assets',
        },
      }),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown OpenGame tool: ${request.params.name}`,
          },
        ],
        isError: true,
      };
    }

    const args = request.params.arguments ?? {};
    const safetyError = validateMcpToolArguments(
      tool.name,
      args,
      options.workspaceRoot,
    );
    if (safetyError) {
      return {
        content: [{ type: 'text', text: safetyError }],
        isError: true,
      };
    }

    const result = await tool.validateBuildAndExecute(args, extra.signal);
    return {
      content: [{ type: 'text', text: toolResultToText(result) }],
      isError: Boolean(result.error),
    };
  });

  return server;
}
