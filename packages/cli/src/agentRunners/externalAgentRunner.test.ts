/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildAgentPrompt,
  createAgentLaunchSpec,
  resolveAssetBackend,
  summarizeAgentEvent,
} from './externalAgentRunner.js';

describe('externalAgentRunner', () => {
  it('builds a workspace-write Codex invocation that reads the prompt from stdin', () => {
    const spec = createAgentLaunchSpec({
      engine: 'codex',
      prompt: 'Build a platformer',
      cwd: '/workspace/game',
      model: 'gpt-5.2-codex',
      gameTools: false,
    });

    expect(spec).toEqual({
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--sandbox',
        'workspace-write',
        '--cd',
        '/workspace/game',
        '--model',
        'gpt-5.2-codex',
        '-',
      ],
      stdin: buildAgentPrompt('Build a platformer'),
    });
  });

  it('maps plan and resume flags to Codex', () => {
    const spec = createAgentLaunchSpec({
      engine: 'codex',
      prompt: 'Review the current game',
      cwd: '/workspace/game',
      approvalMode: 'plan',
      resumeSession: 'thread-123',
      gameTools: false,
    });

    expect(spec.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--cd',
      '/workspace/game',
      'resume',
      'thread-123',
      '-',
    ]);
  });

  it('builds an Antigravity invocation with explicit permission semantics', () => {
    const spec = createAgentLaunchSpec({
      engine: 'agy',
      prompt: 'Build a racing game',
      cwd: '/workspace/game',
      yolo: true,
      continueSession: true,
    });

    expect(spec.command).toBe('agy');
    expect(spec.args).toEqual([
      '--output-format',
      'stream-json',
      '--mode',
      'accept-edits',
      '--dangerously-skip-permissions',
      '--continue',
      '--print',
      buildAgentPrompt('Build a racing game', 'agy'),
    ]);
  });

  it('uses native image generation for Agy and procedural assets for Codex', () => {
    expect(resolveAssetBackend('agy')).toBe('native');
    expect(resolveAssetBackend('codex')).toBe('procedural');
    expect(buildAgentPrompt('Build a game', 'agy')).toContain(
      'built-in image generation tool',
    );
    expect(buildAgentPrompt('Build a game', 'codex')).toContain(
      'Do not call external image-generation APIs',
    );
  });

  it('enables provider-backed MCP tools only when explicitly selected', () => {
    const spec = createAgentLaunchSpec({
      engine: 'codex',
      prompt: 'Build a game',
      cwd: '/workspace/game',
      assetBackend: 'provider',
    });

    expect(spec.args.some((arg) => arg.includes('--provider-tools'))).toBe(
      true,
    );
    expect(spec.stdin).toContain('generate_game_assets');
  });

  it('extracts final text and session IDs from Codex JSONL', () => {
    expect(
      summarizeAgentEvent(
        JSON.stringify({ type: 'thread.started', thread_id: 'abc-123' }),
      ),
    ).toEqual({ sessionId: 'abc-123' });
    expect(
      summarizeAgentEvent(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Game created.' },
        }),
      ),
    ).toEqual({ text: 'Game created.' });
  });

  it('extracts Antigravity result events and ignores non-JSON output', () => {
    expect(
      summarizeAgentEvent(
        JSON.stringify({
          type: 'result',
          result: 'Done',
          session_id: 'session-1',
        }),
      ),
    ).toEqual({ text: 'Done', sessionId: 'session-1' });
    expect(
      summarizeAgentEvent(
        JSON.stringify({
          event: 'result',
          result: {
            conversation_id: 'conversation-1',
            status: 'SUCCESS',
            response: 'Game complete.\n',
          },
        }),
      ),
    ).toEqual({ text: 'Game complete.\n', sessionId: 'conversation-1' });
    expect(summarizeAgentEvent('not JSON')).toEqual({});
  });
});
