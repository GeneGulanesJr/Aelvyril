import { describe, it, expect } from 'vitest';
import { JsonRpcClient } from '../../src/agents/json-rpc.js';

describe('JsonRpcClient', () => {
  it('creates a valid JSON-RPC request', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('healthcheck', {});
    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('healthcheck');
    expect(request.id).toBeDefined();
  });

  it('parses a valid JSON-RPC response', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('healthcheck', {});
    const response = client.parseResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { status: 'ok' },
    }));
    expect(response.result).toEqual({ status: 'ok' });
  });

  it('throws on JSON-RPC error response', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('bad_method', {});
    expect(() => {
      client.parseResponse(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' },
      }));
    }).toThrow('Method not found');
  });

  it('frames a message with Content-Length header', () => {
    const client = new JsonRpcClient();
    const frame = client.frame({ jsonrpc: '2.0', method: 'test', id: 1 });
    expect(frame).toContain('Content-Length:');
    expect(frame).toContain('"method":"test"');
  });
});
