# Agent Helper: blender-mcp

This helper file gives AI agents a fast and reliable entry point into this subproject.

## Scope

- Runtime: Node.js (ESM)
- Language: TypeScript (build output to `dist/`)
- Runtime entry point: `dist/index.js`
- Compatibility entry: `index.js` (forwards to `dist/index.js`)

## Important Files

- `src/index.ts`: MCP server implementation
- `test/test-all-tools.mjs`: integration tests with mocks
- `test/test-real-tools.mjs`: real integration tests without mocks
- `.env.example`: example real-test configuration
- `package.json`: build/start/test scripts
- `tsconfig.json`: TypeScript configuration

## Core Rules for Agents

- For MCP stdio, never write free-form text to stdout/stderr.
- Write diagnostics only to the log file (`index-start.log`).
- Use `server.registerTool(...)` for tool registration, not `server.tool(...)`.
- Tool descriptions should include a clear payload hint (`Payload: ...`).

## Build and Test

```bash
npm run build
npm test
```

### Real Tests (without mocks)

```bash
npm run test:real
```

### Strict Real Tests

- Requires a `.env` file in the project directory.
- Requires `RUN_REAL_TESTS=1` in that `.env` file.

```bash
npm run test:real:strict
```

## Prompt Templates for Agents

- "Add a new MCP tool in `src/index.ts` and create matching tests in `test/test-all-tools.mjs`."
- "Update the tool description and keep the payload format consistent."
- "Run build and tests and fix TypeScript errors."
