import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
    const block = result?.content?.find((entry) => entry.type === 'text');
    return block?.text || '';
}

function parseTrailingJson(text) {
    const start = text.indexOf('{');
    if (start < 0) {
        return null;
    }

    const candidate = text.slice(start);
    try {
        return JSON.parse(candidate);
    } catch {
        return null;
    }
}

function assertToolPresent(tools, name) {
    const found = tools.find((tool) => tool.name === name);
    assert.ok(found, `Tool missing: ${name}`);
    assert.ok(found.description?.includes('Payload:'), `Missing payload hint for tool: ${name}`);
}

function parseDotEnv(envText) {
    const values = {};
    const lines = envText.split(/\r?\n/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const eqPos = line.indexOf('=');
        if (eqPos <= 0) {
            continue;
        }

        const key = line.slice(0, eqPos).trim();
        let value = line.slice(eqPos + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        values[key] = value;
    }

    return values;
}

function loadEnvFile(cwd) {
    const envFilePath = path.join(cwd, '.env');
    if (!fs.existsSync(envFilePath)) {
        return { envFilePath, values: null };
    }

    const envText = fs.readFileSync(envFilePath, 'utf8');
    const values = parseDotEnv(envText);
    for (const [key, value] of Object.entries(values)) {
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }

    return { envFilePath, values };
}

async function main() {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const cwd = path.resolve(testDir, '..');
    const strictMode = process.argv.includes('--strict');
    const { envFilePath, values: envFileValues } = loadEnvFile(cwd);

    if (strictMode) {
        if (!envFileValues) {
            throw new Error(`Strict mode requires a .env file at ${envFilePath}`);
        }

        const envRunReal = envFileValues.RUN_REAL_TESTS;
        if (envRunReal !== '1') {
            throw new Error('Strict mode requires RUN_REAL_TESTS=1 in .env');
        }
    }

    if (process.env.RUN_REAL_TESTS !== '1') {
        console.log('Skipping real integration tests. Set RUN_REAL_TESTS=1 (or add it to .env) to execute non-mocked tests.');
        process.exit(0);
    }

    const proc = spawn(process.execPath, ['dist/index.js'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: true,
    });

    proc.stderr.on('data', (chunk) => {
        process.stderr.write(chunk.toString());
    });

    const transport = new ManualStdioTransport(proc);
    const client = new Client({ name: 'test-client-real-tools', version: '1.0.0' });

    try {
        await client.connect(transport);

        const { tools } = await client.listTools();
        assert.equal(tools.length, 7, 'Expected 7 tools from blender-mcp');

        assertToolPresent(tools, 'send-code-to-blender');
        assertToolPresent(tools, 'test-blender-connection');
        assertToolPresent(tools, 'fetch-scene-from-blender');
        assertToolPresent(tools, 'get-asset-types-from-polyhaven');
        assertToolPresent(tools, 'get-categories-from-polyhaven');
        assertToolPresent(tools, 'get-asset-from-polyhaven');
        assertToolPresent(tools, 'download-asset-from-polyhaven');

        const typesResult = await client.callTool({
            name: 'get-asset-types-from-polyhaven',
            arguments: {},
        });
        const typesText = getTextContent(typesResult);
        assert.match(typesText, /Asset types fetched from PolyHaven/i);

        const categoriesResult = await client.callTool({
            name: 'get-categories-from-polyhaven',
            arguments: { asset_type: 'models' },
        });
        const categoriesText = getTextContent(categoriesResult);
        assert.match(categoriesText, /Categories fetched for "models"/i);

        const assetsResult = await client.callTool({
            name: 'get-asset-from-polyhaven',
            arguments: { asset_type: 'models', category: 'furniture' },
        });
        const assetsText = getTextContent(assetsResult);
        assert.match(assetsText, /Assets fetched/i);

        const assetsJson = parseTrailingJson(assetsText);
        assert.ok(assetsJson && typeof assetsJson === 'object', 'Expected JSON payload from get-asset-from-polyhaven');

        const firstAssetName = Object.keys(assetsJson)[0];
        assert.ok(firstAssetName, 'Expected at least one asset in real PolyHaven response');

        const downloadResult = await client.callTool({
            name: 'download-asset-from-polyhaven',
            arguments: {
                asset_name: firstAssetName,
                asset_type: 'models',
                resolution: '1K',
                file_format: 'blend',
            },
        });
        const downloadText = getTextContent(downloadResult);
        assert.match(downloadText, /(Asset data sent to Blender successfully|Failed to get asset data|No suitable blend download URL found)/i);

        const connResult = await client.callTool({
            name: 'test-blender-connection',
            arguments: {},
        });
        const connText = getTextContent(connResult);
        assert.match(connText, /(Connection test successful|Connection test failed)/i);

        const sceneResult = await client.callTool({
            name: 'fetch-scene-from-blender',
            arguments: {},
        });
        const sceneText = getTextContent(sceneResult);
        assert.match(sceneText, /(Scene fetched from Blender|Failed to fetch scene)/i);

        const sendCodeResult = await client.callTool({
            name: 'send-code-to-blender',
            arguments: { code: 'print("real test")' },
        });
        const sendCodeText = getTextContent(sendCodeResult);
        assert.match(sendCodeText, /(Code sent to Blender successfully|Failed to send code to Blender)/i);

        console.log('Real (non-mocked) integration tests passed.');
    } finally {
        try {
            await transport.close();
        } catch { }

        try {
            proc.kill();
        } catch { }
    }
}

main().catch((error) => {
    console.error('Real integration test failed:', error);
    process.exit(1);
});
