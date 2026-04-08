# Blender MCP (Workspace Version)

This directory contains the local MCP server for Blender.

## Overview

- Implementation: TypeScript (`src/index.ts`)
- Build target: `dist/index.js`
- Runtime entry: `dist/index.js`
- Compatibility entry: `index.js` (forwards to `dist/index.js`)
- Protocol: MCP over stdio + local TCP bridge to Blender

## Requirements

- Node.js 20+
- npm
- Optional for real tests: running Blender bridge on `BLENDER_HOST:BLENDER_PORT`

## Installation

```bash
npm install
```

## Build and Start

```bash
npm run build
npm start
```

## Scripts

- `npm run build`: Compile TypeScript to `dist/`
- `npm run watch`: TypeScript watch mode
- `npm start`: Start server from `dist/index.js`
- `npm run start:compat`: Start compatibility entry (`index.js`)
- `npm test`: Run all tool tests with mocks (stable for CI)
- `npm run test:all-tools`: Mock-based tool integration tests
- `npm run test:real`: Real tests without mocks (when `RUN_REAL_TESTS=1`)
- `npm run test:real:strict`: Real tests requiring `.env` + `RUN_REAL_TESTS=1`

## Test Modes

### 1) Mock tests (recommended for CI)

```bash
npm test
```

### 2) Real tests (without mocks)

Runs real PolyHaven calls and validates Blender tools against the local bridge.

```bash
set RUN_REAL_TESTS=1
npm run test:real
```

### 3) Strict real tests

Requires a `.env` file in the project directory and `RUN_REAL_TESTS=1` in that file.

```bash
npm run test:real:strict
```

## Configuration

Use `.env.example` as a template:

- `RUN_REAL_TESTS=1`
- `BLENDER_HOST=127.0.0.1`
- `BLENDER_PORT=8765`
- `BLENDER_TIMEOUT_MS=5000`
- `POLYHAVEN_API_BASE=https://api.polyhaven.com`

## Notes for Agents

See `AGENTS.md` in this directory for concrete guidelines (tool registration, logging rules, test workflow).
