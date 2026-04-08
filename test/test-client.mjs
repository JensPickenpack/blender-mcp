import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

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
    } catch {}
  }

  get stderr() {
    return this._proc.stderr;
  }

  get pid() {
    return this._proc.pid;
  }
}

async function main() {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const cwd = path.resolve(testDir, '..');
  const nodePath = process.execPath || 'node';

  const proc = spawn(nodePath, ['index.js'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  });

  proc.stderr.on('data', (d) => {
    try {
      process.stderr.write('[server-stderr] ' + d.toString());
    } catch {}
  });

  proc.on('close', (code, signal) => {
    try {
      console.log('[server-close] code=', code, 'signal=', signal);
    } catch {}
  });

  proc.on('exit', (code, signal) => {
    try {
      console.log('[server-exit] code=', code, 'signal=', signal);
    } catch {}
  });

  const transport = new ManualStdioTransport(proc);
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    console.log('Connected to MCP server (spawned child). Listing tools first...');
    const { tools } = await client.listTools();
    console.log('Available tools:', tools.map((t) => t.name));
    console.log('Calling tool: test-blender-connection');
    const result = await client.callTool({ name: 'test-blender-connection', arguments: {} });
    console.log('Tool result:');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error during MCP client run:', err instanceof Error ? err.message : err);
  } finally {
    try {
      await transport.close();
    } catch {}

    try {
      proc.kill();
    } catch {}
  }
}

main();
