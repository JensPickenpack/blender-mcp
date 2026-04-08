import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class ManualStdioTransport {
    constructor(proc) {
        this._proc = proc;
        this._readBuffer = new ReadBuffer();
    }

    async start() {
        this._proc.stdout.on('data', (chunk) => {
            this._readBuffer.append(chunk);
            let msg;
            while ((msg = this._readBuffer.readMessage()) !== null) {
                try {
                    this.onmessage?.(msg);
                } catch (e) {
                    this.onerror?.(e);
                }
            }
        });

        this._proc.on('error', (e) => this.onerror?.(e));
        this._proc.on('close', () => this.onclose?.());
    }

    send(message) {
        const json = serializeMessage(message);
        return new Promise((resolve) => {
            if (!this._proc.stdin.write(json)) {
                this._proc.stdin.once('drain', resolve);
            } else {
                resolve();
            }
        });
    }

    async close() {
        try {
            this._proc.stdin.end();
        } catch { }
    }
}

function getTextContent(result) {
    const textBlock = result?.content?.find((entry) => entry.type === 'text');
    return textBlock?.text || '';
}

async function startMockBlenderServer(port) {
    const received = [];

    const server = createNetServer((socket) => {
        let input = '';

        socket.on('data', (chunk) => {
            input += chunk.toString('utf8');
        });

        socket.on('end', () => {
            let payload;
            try {
                payload = JSON.parse(input);
            } catch {
                payload = { type: 'invalid', raw: input };
            }

            received.push(payload);

            let response;
            if (payload.type === 'code') {
                response = { ok: true, bridge: 'mock-blender', echoCode: payload.code };
            } else if (payload.type === 'fetch-scene') {
                response = { ok: true, scene: { name: 'MockScene', objects: 3 } };
            } else if (payload.type === 'asset-data') {
                response = { ok: true, imported: payload.asset_name, blend_url: payload.blend_url };
            } else {
                response = { ok: false, error: 'unknown payload', payload };
            }

            socket.write(JSON.stringify(response));
            socket.end();
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });

    return {
        received,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function startMockPolyhavenServer(port) {
    const requests = [];

    const server = createHttpServer((req, res) => {
        requests.push(req.url || '');

        if (req.url === '/types') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hdris: 1, models: 2, textures: 3 }));
            return;
        }

        if (req.url === '/categories/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(['furniture', 'vehicles']));
            return;
        }

        if (req.url === '/assets?t=models&c=furniture') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ wood_chair: { name: 'Wood Chair' } }));
            return;
        }

        if (req.url === '/files/wood_chair') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    blend: {
                        '1K': {
                            blend: {
                                url: 'https://example.invalid/wood_chair_1k.blend',
                                include: { textures: ['albedo', 'normal'] },
                            },
                        },
                    },
                }),
            );
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found', path: req.url }));
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });

    return {
        requests,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function main() {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const cwd = path.resolve(testDir, '..');

    const blenderPort = 18765;
    const polyhavenPort = 18080;

    const blenderMock = await startMockBlenderServer(blenderPort);
    const polyhavenMock = await startMockPolyhavenServer(polyhavenPort);

    const proc = spawn(process.execPath, ['dist/index.js'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            BLENDER_HOST: '127.0.0.1',
            BLENDER_PORT: String(blenderPort),
            POLYHAVEN_API_BASE: `http://127.0.0.1:${polyhavenPort}`,
        },
        windowsHide: true,
    });

    const transport = new ManualStdioTransport(proc);
    const client = new Client({ name: 'test-client-all-tools', version: '1.0.0' });

    try {
        await client.connect(transport);

        const { tools } = await client.listTools();
        const names = new Set(tools.map((t) => t.name));

        const expectedTools = [
            'send-code-to-blender',
            'test-blender-connection',
            'fetch-scene-from-blender',
            'get-asset-types-from-polyhaven',
            'get-categories-from-polyhaven',
            'get-asset-from-polyhaven',
            'download-asset-from-polyhaven',
        ];

        for (const toolName of expectedTools) {
            assert.ok(names.has(toolName), `Tool missing: ${toolName}`);
        }

        for (const tool of tools) {
            assert.ok(tool.description && tool.description.includes('Payload:'), `Missing payload hint in description for ${tool.name}`);
        }

        const sendCodeResult = await client.callTool({
            name: 'send-code-to-blender',
            arguments: { code: 'print("Tool test")' },
        });
        assert.match(getTextContent(sendCodeResult), /Code sent to Blender successfully/i);

        const connResult = await client.callTool({
            name: 'test-blender-connection',
            arguments: {},
        });
        assert.match(getTextContent(connResult), /Connection test successful/i);

        const sceneResult = await client.callTool({
            name: 'fetch-scene-from-blender',
            arguments: {},
        });
        assert.match(getTextContent(sceneResult), /Scene fetched from Blender/i);

        const typesResult = await client.callTool({
            name: 'get-asset-types-from-polyhaven',
            arguments: {},
        });
        assert.match(getTextContent(typesResult), /Asset types fetched from PolyHaven/i);

        const categoriesResult = await client.callTool({
            name: 'get-categories-from-polyhaven',
            arguments: { asset_type: 'models' },
        });
        assert.match(getTextContent(categoriesResult), /Categories fetched for "models"/i);

        const assetsResult = await client.callTool({
            name: 'get-asset-from-polyhaven',
            arguments: { asset_type: 'models', category: 'furniture' },
        });
        assert.match(getTextContent(assetsResult), /Assets fetched/i);

        const downloadResult = await client.callTool({
            name: 'download-asset-from-polyhaven',
            arguments: {
                asset_name: 'wood_chair',
                asset_type: 'models',
                resolution: '1K',
                file_format: 'blend',
            },
        });
        assert.match(getTextContent(downloadResult), /Asset data sent to Blender successfully/i);

        assert.ok(blenderMock.received.some((p) => p.type === 'code'), 'Expected code payload not sent to Blender mock');
        assert.ok(blenderMock.received.some((p) => p.type === 'fetch-scene'), 'Expected fetch-scene payload not sent to Blender mock');
        assert.ok(blenderMock.received.some((p) => p.type === 'asset-data'), 'Expected asset-data payload not sent to Blender mock');

        assert.ok(polyhavenMock.requests.includes('/types'), 'Expected /types request missing');
        assert.ok(polyhavenMock.requests.includes('/categories/models'), 'Expected /categories/models request missing');
        assert.ok(polyhavenMock.requests.includes('/assets?t=models&c=furniture'), 'Expected /assets request missing');
        assert.ok(polyhavenMock.requests.includes('/files/wood_chair'), 'Expected /files/wood_chair request missing');

        console.log('All tool tests passed.');
    } finally {
        try {
            await transport.close();
        } catch { }

        try {
            proc.kill();
        } catch { }

        await Promise.allSettled([blenderMock.close(), polyhavenMock.close()]);
    }
}

main().catch((error) => {
    console.error('Tool integration test failed:', error);
    process.exit(1);
});
