/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { loadSettings } from '../config/settings.js';
import { createOpenGameToolsServer } from './opengameToolsServer.js';

function getWorkspaceRoot(args: string[]): string {
  const workspaceIndex = args.indexOf('--workspace');
  const requested =
    workspaceIndex >= 0 && args[workspaceIndex + 1]
      ? args[workspaceIndex + 1]
      : process.cwd();
  return path.resolve(requested);
}

// STDIO MCP reserves stdout for JSON-RPC frames.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const workspaceRoot = getWorkspaceRoot(process.argv.slice(2));
const includeProviderTools = process.argv.includes('--provider-tools');
const settings = loadSettings(workspaceRoot);
const server = createOpenGameToolsServer({
  workspaceRoot,
  providers: settings.merged.openGame?.providers,
  includeProviderTools,
});
await server.connect(new StdioServerTransport());
