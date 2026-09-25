/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import commandExists from 'command-exists';
import { createInterface } from 'node:readline';
import {
  appendCodexMcpConfig,
  getOpenGameMcpDefinition,
  prepareAgyMcpConfig,
} from './mcpIntegration.js';

export type AgentEngine = 'auto' | 'codex' | 'agy' | 'legacy';
export type ExternalAgentEngine = Exclude<AgentEngine, 'auto' | 'legacy'>;
export type AssetBackend = 'auto' | 'native' | 'procedural' | 'provider';
export type ResolvedAssetBackend = Exclude<AssetBackend, 'auto'>;

export interface ExternalAgentRunOptions {
  engine: ExternalAgentEngine;
  prompt: string;
  cwd: string;
  model?: string;
  outputFormat?: string;
  approvalMode?: string;
  yolo?: boolean;
  continueSession?: boolean;
  resumeSession?: string;
  gameTools?: boolean;
  assetBackend?: AssetBackend;
}

export interface AgentLaunchSpec {
  command: ExternalAgentEngine;
  args: string[];
  stdin?: string;
}

export interface AgentEventSummary {
  text?: string;
  sessionId?: string;
}

const GAME_AGENT_PREAMBLE = `You are the OpenGame game-building agent. Work directly in the current workspace and turn the user's request into a complete, playable web game. Inspect and preserve the existing project conventions, implement the game rather than only describing it, create cohesive visuals, and run the relevant build or tests before finishing. Keep all edits inside the workspace. When the opengame_builtin generate_tilemap MCP tool is available, use it when it benefits a map-based game.`;

const ASSET_INSTRUCTIONS: Record<ResolvedAssetBackend, string> = {
  native:
    'Use your built-in image generation tool for important raster game assets and save the generated files under public/assets. Prefer transparent backgrounds for sprites when supported. If native image generation is unavailable, fall back to cohesive SVG, Canvas, CSS, or procedural pixel-art assets without calling an external image API.',
  procedural:
    'Do not call external image-generation APIs. Create all visuals locally with SVG, Canvas, CSS, procedural geometry, or programmatic pixel art. Keep a coherent palette and make every generated asset part of the playable game.',
  provider:
    'Use the opengame_builtin generate_game_assets tool for provider-backed images or audio. If a provider tool fails, continue with locally generated procedural assets instead of stopping.',
};

export function resolveAgentEngine(engine: AgentEngine): AgentEngine {
  if (engine !== 'auto') {
    return engine;
  }

  if (commandExists.sync('codex')) {
    return 'codex';
  }
  if (commandExists.sync('agy')) {
    return 'agy';
  }
  return 'legacy';
}

export function resolveAssetBackend(
  engine: ExternalAgentEngine,
  backend: AssetBackend = 'auto',
): ResolvedAssetBackend {
  if (backend !== 'auto') {
    return backend;
  }
  return engine === 'agy' ? 'native' : 'procedural';
}

export function buildAgentPrompt(
  prompt: string,
  engine: ExternalAgentEngine = 'codex',
  backend: AssetBackend = 'auto',
): string {
  const resolvedBackend = resolveAssetBackend(engine, backend);
  const planningInstruction =
    resolvedBackend === 'provider'
      ? 'Use the opengame_builtin classify_game_type and generate_gdd tools early, and save the returned GDD as GAME_DESIGN.md.'
      : 'Classify the game archetype yourself and create GAME_DESIGN.md directly; do not call a provider-backed classifier or GDD generator.';
  return `${GAME_AGENT_PREAMBLE}\n\nPlanning strategy:\n${planningInstruction}\n\nAsset strategy:\n${ASSET_INSTRUCTIONS[resolvedBackend]}\n\nUser request:\n${prompt.trim()}`;
}

export function createAgentLaunchSpec(
  options: ExternalAgentRunOptions,
): AgentLaunchSpec {
  const assetBackend = resolveAssetBackend(
    options.engine,
    options.assetBackend,
  );
  const prompt = buildAgentPrompt(options.prompt, options.engine, assetBackend);

  if (options.engine === 'codex') {
    const sandbox =
      options.approvalMode === 'plan' ? 'read-only' : 'workspace-write';
    const args = ['exec', '--json', '--sandbox', sandbox, '--cd', options.cwd];

    if (options.gameTools !== false) {
      appendCodexMcpConfig(
        args,
        getOpenGameMcpDefinition(options.cwd, {
          providerTools: assetBackend === 'provider',
        }),
      );
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    if (options.continueSession || options.resumeSession !== undefined) {
      args.push('resume');
      if (options.resumeSession) {
        args.push(options.resumeSession);
      } else {
        args.push('--last');
      }
    }

    args.push('-');
    return { command: 'codex', args, stdin: prompt };
  }

  const args = [
    '--output-format',
    'stream-json',
    '--mode',
    options.approvalMode === 'plan' ? 'plan' : 'accept-edits',
  ];
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.yolo || options.approvalMode === 'yolo') {
    args.push('--dangerously-skip-permissions');
  }
  if (options.continueSession) {
    args.push('--continue');
  } else if (options.resumeSession) {
    args.push('--conversation', options.resumeSession);
  }
  args.push('--print', prompt);
  return { command: 'agy', args };
}

export function summarizeAgentEvent(line: string): AgentEventSummary {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }

  const summary: AgentEventSummary = {};
  if (typeof event['thread_id'] === 'string') {
    summary.sessionId = event['thread_id'];
  } else if (typeof event['session_id'] === 'string') {
    summary.sessionId = event['session_id'];
  } else if (typeof event['conversation_id'] === 'string') {
    summary.sessionId = event['conversation_id'];
  } else if (event['event'] === 'init') {
    const init = event['init'] as Record<string, unknown> | undefined;
    if (typeof init?.['conversation_id'] === 'string') {
      summary.sessionId = init['conversation_id'];
    }
  }

  if (event['type'] === 'item.completed') {
    const item = event['item'] as Record<string, unknown> | undefined;
    if (
      item?.['type'] === 'agent_message' &&
      typeof item['text'] === 'string'
    ) {
      summary.text = item['text'];
    }
  } else if (
    event['type'] === 'result' &&
    typeof event['result'] === 'string'
  ) {
    summary.text = event['result'];
  } else if (event['type'] === 'assistant') {
    const message = event['message'] as Record<string, unknown> | undefined;
    const content = message?.['content'];
    if (Array.isArray(content)) {
      const text = content
        .map((block) => {
          if (
            typeof block === 'object' &&
            block !== null &&
            (block as Record<string, unknown>)['type'] === 'text'
          ) {
            const value = (block as Record<string, unknown>)['text'];
            return typeof value === 'string' ? value : '';
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (text) {
        summary.text = text;
      }
    }
  } else if (event['event'] === 'result') {
    const result = event['result'] as Record<string, unknown> | undefined;
    if (typeof result?.['response'] === 'string') {
      summary.text = result['response'];
    }
    if (typeof result?.['conversation_id'] === 'string') {
      summary.sessionId = result['conversation_id'];
    }
  }

  return summary;
}

export async function runExternalAgent(
  options: ExternalAgentRunOptions,
): Promise<number> {
  const spec = createAgentLaunchSpec(options);
  const cleanupMcpConfig =
    options.engine === 'agy' && options.gameTools !== false
      ? await prepareAgyMcpConfig(
          getOpenGameMcpDefinition(options.cwd, {
            providerTools:
              resolveAssetBackend(options.engine, options.assetBackend) ===
              'provider',
          }),
        )
      : async () => {};

  return new Promise<number>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.on('error', async (error) => {
      await cleanupMcpConfig();
      reject(
        new Error(
          `Unable to start ${spec.command}. Install it and sign in before using --engine ${spec.command}.`,
          { cause: error },
        ),
      );
    });

    child.stderr.pipe(process.stderr);

    let lastText = '';
    let sessionId: string | undefined;
    const unparsedLines: string[] = [];
    const streamJson = options.outputFormat === 'stream-json';

    if (streamJson) {
      child.stdout.pipe(process.stdout);
    } else {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const summary = summarizeAgentEvent(line);
        if (summary.text) {
          lastText = summary.text;
        }
        if (summary.sessionId) {
          sessionId = summary.sessionId;
        }
        if (!summary.text && !summary.sessionId) {
          try {
            JSON.parse(line);
          } catch {
            unparsedLines.push(line);
          }
        }
      });
    }

    child.on('close', async (code) => {
      const exitCode = code ?? 1;
      if (!streamJson) {
        const fallbackText = unparsedLines.join('\n').trim();
        const response = lastText || fallbackText;
        if (options.outputFormat === 'json') {
          process.stdout.write(
            `${JSON.stringify({
              engine: options.engine,
              status: exitCode === 0 ? 'success' : 'error',
              response,
              ...(sessionId ? { sessionId } : {}),
            })}\n`,
          );
        } else if (response) {
          process.stdout.write(`${response}\n`);
        }
      }
      await cleanupMcpConfig();
      resolve(exitCode);
    });

    if (spec.stdin !== undefined) {
      child.stdin.end(spec.stdin);
    } else {
      child.stdin.end();
    }
  });
}
