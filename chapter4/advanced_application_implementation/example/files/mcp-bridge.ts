// src/mcp-bridge.ts
/**
 * MCP bridge — expose a `CraftControlSession` as an MCP server over stdio.
 *
 * The MCP tool surface mirrors the reference meta-tools (`command_run`,
 * `command_batch`, `doc_new`, `doc_save`, `doc_inspect`, `ui_screenshot`)
 * but every one of them is *translated* into a loopback control frame and
 * dispatched through the authenticated `CraftControlSession`.
 *
 * This lets you keep a single long-lived engine process handling both the
 * browser UI (via the direct session) and the agent swarm (via MCP)
 * without duplicating state.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CraftControlSession } from './session.js';

/**
 * Create the MCP server and wire each tool into the loopback session.
 * The returned server must be connected to a transport by the caller.
 */
export function buildMcpBridge(session: CraftControlSession): Server {
  const server = new Server(
    {
      name: 'artcraft-loopback-bridge',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ------------------------------------------------------------------
  // Tool catalogue. Every tool is 1:1 with a loopback `method`.
  // ------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'command_run',
        description:
          'Run any ArtCraft command by id with JSON params (e.g. ' +
          'layer.newAdjustmentLayer.curves, filter.blur.gaussianBlur).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Command id' },
            params: { type: 'object', description: 'Command parameters' },
          },
          required: ['id'],
        },
      },
      {
        name: 'command_batch',
        description:
          'Run several ArtCraft commands in one undoable step.',
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  params: { type: 'object' },
                },
                required: ['id'],
              },
            },
            stop_on_error: { type: 'boolean' },
          },
          required: ['steps'],
        },
      },
      {
        name: 'doc_inspect',
        description: 'Return the full document JSON tree.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'ui_screenshot',
        description: 'Capture a PNG screenshot of the live engine window.',
        inputSchema: {
          type: 'object',
          properties: {
            max_side: { type: 'number' },
            path: { type: 'string' },
          },
        },
      },
      {
        name: 'doc_save',
        description: 'Save the active document.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            format: { type: 'string' },
          },
        },
      },
      {
        name: 'doc_new',
        description: 'Create a new document.',
        inputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
            mode: { type: 'string' },
            background: { type: 'string' },
          },
        },
      },
    ],
  }));

  // ------------------------------------------------------------------
  // Dispatcher. Every tool call flows through the shared session.
  // ------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    switch (name) {
      case 'command_run': {
        const id = String(args.id);
        const params = (args.params as Record<string, unknown>) ?? {};
        const result = await session.executeCommand(id, params);
        return textResult(result);
      }

      case 'command_batch': {
        const steps = (args.steps as Array<{
          id: string;
          params?: Record<string, unknown>;
        }>) ?? [];
        const stopOnError = Boolean(args.stop_on_error ?? true);
        const result = await session.executeBatch(steps, {
          stopOnError,
        });
        return textResult(result);
      }

      case 'doc_inspect': {
        const result = await session.executeCommand('document.inspect', {});
        return textResult(result);
      }

      case 'ui_screenshot': {
        const shot = await session.screenshot({
          maxSide: Number(args.max_side ?? 1024),
          path: args.path as string | undefined,
        });
        return {
          content: [
            {
              type: 'image',
              data: shot.dataBase64,
              mimeType: 'image/png',
            },
          ],
        };
      }

      case 'doc_save': {
        const result = await session.executeCommand('file.save', {
          path: args.path,
          format: args.format,
        });
        return textResult(result);
      }

      case 'doc_new': {
        const result = await session.executeCommand('file.new', {
          width: Number(args.width ?? 1920),
          height: Number(args.height ?? 1080),
          mode: String(args.mode ?? 'rgb'),
          background: String(args.background ?? 'white'),
        });
        return textResult(result);
      }

      default:
        return {
          isError: true,
          content: [
            { type: 'text', text: `Unknown tool: ${name}` },
          ],
        };
    }
  });

  return server;
}

/** Helper: wrap a JSON result as an MCP text content block. */
function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value ?? null, null, 2),
      },
    ],
  };
}

/**
 * Convenience: run the bridge on stdio until the transport closes.
 */
export async function runMcpBridgeOnStdio(
  session: CraftControlSession,
): Promise<void> {
  const server = buildMcpBridge(session);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
