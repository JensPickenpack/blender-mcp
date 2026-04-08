import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './dist/index.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.resolve(moduleDir, 'index-start.log');
const BLENDER_HOST = process.env.BLENDER_HOST || 'localhost';
const BLENDER_PORT = Number(process.env.BLENDER_PORT || 8765);
const SOCKET_TIMEOUT_MS = Number(process.env.BLENDER_TIMEOUT_MS || 5000);
const POLYHAVEN_API_BASE = 'https://api.polyhaven.com';

// Keep log serialization defensive because socket and fetch errors can include circular objects.
function serializeLogValue(value) {
  if (value && value.stack) {
    return value.stack;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function appendLog(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(serializeLogValue).join(' ')}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // Logging must never break the MCP stdio protocol.
  }
}

function dbg(...args) {
  appendLog('INFO', ...args);
}

function dbgErr(...args) {
  appendLog('ERROR', ...args);
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : 'Unknown error';
}

function textResponse(text) {
  return { content: [{ type: 'text', text }] };
}

function nowIso() {
  return new Date().toISOString();
}

// Encapsulates the local TCP bridge to Blender, so MCP tools stay transport-agnostic.
class BlenderClient {
  constructor(net, host = BLENDER_HOST, port = BLENDER_PORT) {
    this.net = net;
    this.host = host;
    this.port = port;
  }

  async sendMessage(messageObject) {
    return new Promise((resolve, reject) => {
      const client = this.net.createConnection(this.port, this.host);
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

      client.on('data', (data) => {
        buffer += data.toString();
        try {
          const response = JSON.parse(buffer);
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

      client.on('error', (error) => {
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
          resolve(JSON.parse(buffer));
        } catch {
          reject(new Error(`Connection closed with invalid JSON: ${buffer}`));
        }
      });
    });
  }

  async sendCode(code) {
    return this.sendMessage({ type: 'code', code, timestamp: nowIso() });
  }

  async fetchScene() {
    return this.sendMessage({ type: 'fetch-scene', timestamp: nowIso() });
  }

  async sendAssetData(assetData) {
    return this.sendMessage({ type: 'asset-data', ...assetData, timestamp: nowIso() });
  }
}

async function fetchJson(url, contextLabel) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${contextLabel} failed: HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function resolveDefaultsForAssetType(assetType) {
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

function resolveBlendDownload(assetFiles, targetResolution) {
  if (!assetFiles || !assetFiles.blend) {
    return { downloadUrl: null, includesData: null };
  }

  const preferred = assetFiles.blend[targetResolution]?.blend;
  if (preferred && preferred.url) {
    return { downloadUrl: preferred.url, includesData: preferred.include || null };
  }

  const firstResolution = Object.keys(assetFiles.blend)[0];
  const fallback = firstResolution ? assetFiles.blend[firstResolution]?.blend : null;
  if (fallback && fallback.url) {
    return { downloadUrl: fallback.url, includesData: fallback.include || null };
  }

  return { downloadUrl: null, includesData: null };
}

// Centralized registration keeps bootstrap minimal and makes tools easier to evolve independently.
function registerServerTools(server, z, blenderClient) {
  server.tool(
    'send-code-to-blender',
    'Executes provided Python code in Blender via the local TCP bridge and returns Blender output as JSON.',
    { code: z.string().describe('Python code snippet to execute in Blender.') },
    async ({ code }) => {
      try {
        const response = await blenderClient.sendCode(code);
        return textResponse(`Code sent to Blender successfully.\n\nSent code:\n${code}\n\nBlender response:\n${JSON.stringify(response, null, 2)}`);
      } catch (error) {
        dbgErr('send-code-to-blender failed', error);
        return textResponse(`Failed to send code to Blender: ${safeErrorMessage(error)}\n\nCode that failed to send:\n${code}`);
      }
    },
  );

  server.tool(
    'test-blender-connection',
    'Performs a lightweight health check by sending a print statement to Blender and returning the bridge response.',
    {},
    async () => {
      try {
        const response = await blenderClient.sendCode('print("Hello from MCP!")');
        return textResponse(`Connection test successful.\n\nBlender response:\n${JSON.stringify(response, null, 2)}`);
      } catch (error) {
        dbgErr('test-blender-connection error', error);
        return textResponse(`Connection test failed: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.tool(
    'fetch-scene-from-blender',
    'Requests a scene snapshot from Blender through the bridge, including currently loaded scene metadata.',
    {},
    async () => {
      try {
        const response = await blenderClient.fetchScene();
        return textResponse(`Scene fetched from Blender:\n${JSON.stringify(response, null, 2)}`);
      } catch (error) {
        dbgErr('fetch-scene-from-blender error', error);
        return textResponse(`Failed to fetch scene: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.tool(
    'get-asset-types-from-polyhaven',
    'Lists top-level asset domains available on Poly Haven (for example: hdris, models, textures).',
    {},
    async () => {
      try {
        const assetTypes = await fetchJson(`${POLYHAVEN_API_BASE}/types`, 'Poly Haven asset type request');
        return textResponse(`Asset types fetched from PolyHaven:\n${JSON.stringify(assetTypes, null, 2)}`);
      } catch (error) {
        dbgErr('get-asset-types-from-polyhaven error', error);
        return textResponse(`Failed to fetch asset types: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.tool(
    'get-categories-from-polyhaven',
    'Returns valid Poly Haven categories for a selected asset type, used to narrow asset discovery queries.',
    { asset_type: z.string().describe('Asset type to inspect (for example: models, hdris, textures).') },
    async ({ asset_type }) => {
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

  server.tool(
    'get-asset-from-polyhaven',
    'Lists Poly Haven assets matching a type/category filter. Use this before resolving concrete download files.',
    {
      asset_type: z.string().describe('Asset type filter (for example: models, hdris, textures).'),
      category: z.string().describe('Category filter returned by get-categories-from-polyhaven.'),
    },
    async ({ asset_type, category }) => {
      try {
        const assets = await fetchJson(`${POLYHAVEN_API_BASE}/assets?t=${asset_type}&c=${category}`, 'Poly Haven asset list request');
        return textResponse(`Assets fetched:\n\n${JSON.stringify(assets, null, 2)}`);
      } catch (error) {
        dbgErr('get-asset-from-polyhaven error', error);
        return textResponse(`Failed to fetch assets: ${safeErrorMessage(error)}`);
      }
    },
  );

  server.tool(
    'download-asset-from-polyhaven',
    'Resolves file metadata for a Poly Haven asset and forwards selected blend import information to Blender.',
    {
      asset_name: z.string().describe('Poly Haven asset identifier to download metadata for.'),
      asset_type: z.string().describe('Asset type (hdris, models, textures) to determine fallback file defaults.'),
      resolution: z.string().optional().describe('Preferred resolution (for example: 1K, 2K, 4K, 8K).'),
      file_format: z.string().optional().describe('Preferred file format (defaults depend on asset type).'),
    },
    async ({ asset_name, asset_type, resolution, file_format }) => {
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

async function bootstrap() {
  dbg('index.js bootstrap start');

  try {
    dbg('dynamic importing modules');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const { z } = await import('zod');
    const net = await import('node:net');
    dbg('modules imported successfully');

    // Only JSON-RPC messages must reach stdio; all diagnostics stay in file logging.
    const server = new McpServer({ name: 'BLENDER_MCP', version: '1.0.0' });
    const blenderClient = new BlenderClient(net);
    registerServerTools(server, z, blenderClient);

    dbg('connecting server to stdio transport');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    dbg('server.connect completed');
  } catch (error) {
    dbgErr('fatal error in index.js bootstrap', error);
    process.exit(1);
  }
}

bootstrap();
