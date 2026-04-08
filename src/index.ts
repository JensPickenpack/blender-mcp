import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(moduleDir, '..');
const logFile = path.resolve(projectDir, 'index-start.log');

const BLENDER_HOST = process.env.BLENDER_HOST || 'localhost';
const BLENDER_PORT = Number(process.env.BLENDER_PORT || 8765);
const SOCKET_TIMEOUT_MS = Number(process.env.BLENDER_TIMEOUT_MS || 5000);
const POLYHAVEN_API_BASE = process.env.POLYHAVEN_API_BASE || 'https://api.polyhaven.com';

type JsonRecord = Record<string, unknown>;

// Keep log serialization defensive because socket and fetch errors can include circular objects.
function serializeLogValue(value: unknown): string {
  if (value instanceof Error && value.stack) {
    return value.stack;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function appendLog(level: 'INFO' | 'ERROR', ...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(serializeLogValue).join(' ')}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // Logging must never break the MCP stdio protocol.
  }
}

function dbg(...args: unknown[]): void {
  appendLog('INFO', ...args);
}

function dbgErr(...args: unknown[]): void {
  appendLog('ERROR', ...args);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function nowIso(): string {
  return new Date().toISOString();
}

// Encapsulates the local TCP bridge to Blender, so MCP tools stay transport-agnostic.
class BlenderClient {
  constructor(
    private readonly host = BLENDER_HOST,
    private readonly port = BLENDER_PORT,
  ) {}

  async sendMessage(messageObject: JsonRecord): Promise<JsonRecord> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.port, this.host);
      let buffer = '';
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        client.destroy();
        reject(new Error(`Timed out waiting for Blender response after ${SOCKET_TIMEOUT_MS}ms`));
      }, SOCKET_TIMEOUT_MS);

      client.on('connect', () => {
        client.write(JSON.stringify(messageObject));
        client.end();
      });

      client.on('data', (data: Buffer) => {
        buffer += data.toString();
        try {
          const response = JSON.parse(buffer) as JsonRecord;
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutId);
          resolve(response);
        } catch {
          // Some responses can arrive in chunks; wait for more data.
        }
      });

      client.on('error', (error: Error) => {
        dbgErr('BlenderClient socket error', error);
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });

      client.on('close', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);

        if (!buffer) {
          reject(new Error('Connection closed without any response'));
          return;
        }

        try {
          resolve(JSON.parse(buffer) as JsonRecord);
        } catch {
          reject(new Error(`Connection closed with invalid JSON: ${buffer}`));
        }
      });
    });
  }

  async sendCode(code: string): Promise<JsonRecord> {
    return this.sendMessage({ type: 'code', code, timestamp: nowIso() });
  }

  async fetchScene(): Promise<JsonRecord> {
    return this.sendMessage({ type: 'fetch-scene', timestamp: nowIso() });
  }

  async sendAssetData(assetData: JsonRecord): Promise<JsonRecord> {
    return this.sendMessage({ type: 'asset-data', ...assetData, timestamp: nowIso() });
  }
}

async function fetchJson(url: string, contextLabel: string): Promise<JsonRecord> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${contextLabel} failed: HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as JsonRecord;
}

function resolveDefaultsForAssetType(assetType: string): { resolution: string; format: string } {
  if (assetType === 'hdris') {
    return { resolution: '1K', format: 'hdr' };
  }
  if (assetType === 'models') {
    return { resolution: '1K', format: 'blend' };
  }
  if (assetType === 'textures') {
    return { resolution: '1K', format: 'jpg' };
  }
  return { resolution: '1K', format: 'jpg' };
}

function resolveBlendDownload(assetFiles: JsonRecord, targetResolution: string): { downloadUrl: string | null; includesData: unknown } {
  const blend = assetFiles.blend as JsonRecord | undefined;
  if (!blend) {
    return { downloadUrl: null, includesData: null };
  }

  const preferredByRes = blend[targetResolution] as JsonRecord | undefined;
  const preferredBlend = preferredByRes?.blend as JsonRecord | undefined;
  const preferredUrl = preferredBlend?.url;
  if (typeof preferredUrl === 'string') {
    return { downloadUrl: preferredUrl, includesData: preferredBlend?.include || null };
  }

  const firstResolution = Object.keys(blend)[0];
  const fallbackByRes = firstResolution ? (blend[firstResolution] as JsonRecord | undefined) : undefined;
  const fallbackBlend = fallbackByRes?.blend as JsonRecord | undefined;
  const fallbackUrl = fallbackBlend?.url;
  if (typeof fallbackUrl === 'string') {
    return { downloadUrl: fallbackUrl, includesData: fallbackBlend?.include || null };
  }

  return { downloadUrl: null, includesData: null };
}

// Centralized registration keeps bootstrap minimal and makes tools easier to evolve independently.
function registerServerTools(server: McpServer, blenderClient: BlenderClient): void {
  server.registerTool(
    'send-code-to-blender',
    {
      description: 'Payload: { code: string }. Executes Python code in Blender via the local TCP bridge and returns Blender JSON output.',
      inputSchema: { code: z.string().describe('Python code snippet to execute in Blender.') },
    },
    async ({ code }: { code: string }) => {
      try {
        const response = await blenderClient.sendCode(code);
        return textResponse(`Code sent to Blender successfully.\n\nSent code:\n${code}\n\nBlender response:\n${JSON.stringify(response, null, 2)}`);
      } catch (error) {
        dbgErr('send-code-to-blender failed', error);
        return textResponse(`Failed to send code to Blender: ${safeErrorMessage(error)}\n\nCode that failed to send:\n${code}`);
      }
    },
  );

  server.registerTool(
    'test-blender-connection',
    {
      description: 'Payload: {}. Performs a lightweight Blender bridge health check by sending a print statement and returning the response.',
    },
    async (_extra) => {
      try {
        const response = await blenderClient.sendCode('print("Hello from MCP!")');
        return textResponse(`Connection test successful.\n\nBlender response:\n${JSON.stringify(response, null, 2)}`);
      } catch (error) {
        dbgErr('test-blender-connection error', error);
        return textResponse(`Connection test failed: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    'fetch-scene-from-blender',
    {
      description: 'Payload: {}. Requests a scene snapshot from Blender through the bridge, including loaded scene metadata.',
    },
    async (_extra) => {
      try {
        const response = await blenderClient.fetchScene();
        return textResponse(`Scene fetched from Blender:\n${JSON.stringify(response, null, 2)}`);
      } catch (error) {
        dbgErr('fetch-scene-from-blender error', error);
        return textResponse(`Failed to fetch scene: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    'get-asset-types-from-polyhaven',
    {
      description: 'Payload: {}. Lists top-level Poly Haven asset types (for example: hdris, models, textures).',
    },
    async (_extra) => {
      try {
        const assetTypes = await fetchJson(`${POLYHAVEN_API_BASE}/types`, 'Poly Haven asset type request');
        return textResponse(`Asset types fetched from PolyHaven:\n${JSON.stringify(assetTypes, null, 2)}`);
      } catch (error) {
        dbgErr('get-asset-types-from-polyhaven error', error);
        return textResponse(`Failed to fetch asset types: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    'get-categories-from-polyhaven',
    {
      description: 'Payload: { asset_type: string }. Returns valid Poly Haven categories for a selected asset type.',
      inputSchema: { asset_type: z.string().describe('Asset type to inspect (for example: models, hdris, textures).') },
    },
    async ({ asset_type }: { asset_type: string }) => {
      try {
        dbg('Received asset_type', asset_type);
        const categories = await fetchJson(`${POLYHAVEN_API_BASE}/categories/${asset_type}`, 'Poly Haven category request');
        return textResponse(`Categories fetched for "${asset_type}":\n\n${JSON.stringify(categories, null, 2)}`);
      } catch (error) {
        dbgErr('get-categories-from-polyhaven error', error);
        return textResponse(`Failed to fetch categories: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    'get-asset-from-polyhaven',
    {
      description: 'Payload: { asset_type: string, category: string }. Lists Poly Haven assets matching the type/category filter.',
      inputSchema: {
        asset_type: z.string().describe('Asset type filter (for example: models, hdris, textures).'),
        category: z.string().describe('Category filter returned by get-categories-from-polyhaven.'),
      },
    },
    async ({ asset_type, category }: { asset_type: string; category: string }) => {
      try {
        const assets = await fetchJson(`${POLYHAVEN_API_BASE}/assets?t=${asset_type}&c=${category}`, 'Poly Haven asset list request');
        return textResponse(`Assets fetched:\n\n${JSON.stringify(assets, null, 2)}`);
      } catch (error) {
        dbgErr('get-asset-from-polyhaven error', error);
        return textResponse(`Failed to fetch assets: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.registerTool(
    'download-asset-from-polyhaven',
    {
      description: 'Payload: { asset_name: string, asset_type: string, resolution?: string, file_format?: string }. Resolves Poly Haven file metadata and forwards blend import data to Blender.',
      inputSchema: {
        asset_name: z.string().describe('Poly Haven asset identifier to download metadata for.'),
        asset_type: z.string().describe('Asset type (hdris, models, textures) to determine fallback file defaults.'),
        resolution: z.string().optional().describe('Preferred resolution (for example: 1K, 2K, 4K, 8K).'),
        file_format: z.string().optional().describe('Preferred file format (defaults depend on asset type).'),
      },
    },
    async ({ asset_name, asset_type, resolution, file_format }: { asset_name: string; asset_type: string; resolution?: string; file_format?: string }) => {
      try {
        const assetFiles = await fetchJson(`${POLYHAVEN_API_BASE}/files/${asset_name}`, 'Poly Haven file metadata request');
        const defaults = resolveDefaultsForAssetType(asset_type);
        const targetResolution = resolution || defaults.resolution;
        const targetFormat = file_format || defaults.format;

        const { downloadUrl, includesData } = resolveBlendDownload(assetFiles, targetResolution);
        if (!downloadUrl) {
          return textResponse(
            `No suitable blend download URL found for asset: ${asset_name}\n` +
              `Asset type: ${asset_type}\n` +
              `Resolution: ${targetResolution}\n` +
              `Format: ${targetFormat}`,
          );
        }

        const blenderResponse = await blenderClient.sendAssetData({
          asset_name,
          asset_type,
          resolution: targetResolution,
          format: targetFormat,
          blend_url: downloadUrl,
          includes: includesData,
        });

        return textResponse(
          `Asset data sent to Blender successfully.\n\n` +
            `Asset name: ${asset_name}\n` +
            `Resolution: ${targetResolution}\n` +
            `Blend URL: ${downloadUrl}\n\n` +
            `Includes data:\n${JSON.stringify(includesData, null, 2)}\n\n` +
            `Blender response:\n${JSON.stringify(blenderResponse, null, 2)}`,
        );
      } catch (error) {
        dbgErr('download-asset-from-polyhaven error', error);
        return textResponse(`Failed to get asset data: ${safeErrorMessage(error)}`);
      }
    },
  );
}

async function bootstrap(): Promise<void> {
  dbg('index.ts bootstrap start');

  try {
    // Only JSON-RPC messages must reach stdio; all diagnostics stay in file logging.
    const server = new McpServer({ name: 'BLENDER_MCP', version: '1.1.0' });
    const blenderClient = new BlenderClient();
    registerServerTools(server, blenderClient);

    dbg('connecting server to stdio transport');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    dbg('server.connect completed');
  } catch (error) {
    dbgErr('fatal error in index.ts bootstrap', error);
    process.exit(1);
  }
}

void bootstrap();
