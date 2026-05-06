import { describe, it, expect } from 'vitest';
import { JsonRpcClient, JsonRpcError } from '../../src/agents/json-rpc.js';

describe('JsonRpcClient', () => {
  it('creates a valid JSON-RPC request', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('healthcheck', {});
    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('healthcheck');
    expect(request.id).toBeDefined();
  });

  it('creates a request without params', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('healthcheck');
    expect(request.params).toBeUndefined();
  });

  it('creates a request with positional params (array)', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('subtract', [42, 23]);
    expect(request.params).toEqual([42, 23]);
  });

  it('auto-increments request IDs', () => {
    const client = new JsonRpcClient();
    const req1 = client.createRequest('test', {});
    const req2 = client.createRequest('test', {});
    expect(req2.id).toBe(req1.id + 1);
  });

  it('parses a valid JSON-RPC response', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('healthcheck', {});
    const response = client.parseResponse(JSON.stringify({
      jsonrpc: '2.0', id: request.id, result: { status: 'ok' },
    }));
    expect(response.result).toEqual({ status: 'ok' });
  });

  it('throws on JSON-RPC error response with correct properties', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('bad_method', {});
    try {
      client.parseResponse(JSON.stringify({
        jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found', data: { method: 'bad_method' } },
      }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JsonRpcError);
      expect(e).toBeInstanceOf(Error);
      const err = e as JsonRpcError;
      expect(err.code).toBe(-32601);
      expect(err.message).toBe('Method not found');
      expect(err.data).toEqual({ method: 'bad_method' });
      expect(err.name).toBe('JsonRpcError');
    }
  });

  it('throws on invalid JSON input', () => {
    const client = new JsonRpcClient();
    try {
      client.parseResponse('not json{{{');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JsonRpcError);
      const err = e as JsonRpcError;
      expect(err.code).toBe(-32700);
      expect(err.message).toContain('Parse error');
    }
  });

  it('throws on wrong jsonrpc version', () => {
    const client = new JsonRpcClient();
    expect(() => {
      client.parseResponse(JSON.stringify({ jsonrpc: '1.0', id: 1, result: {} }));
    }).toThrow('unsupported jsonrpc version');
  });

  it('throws on missing jsonrpc field', () => {
    const client = new JsonRpcClient();
    expect(() => {
      client.parseResponse(JSON.stringify({ id: 1, result: {} }));
    }).toThrow('missing jsonrpc field');
  });

  it('throws on response with neither result nor error', () => {
    const client = new JsonRpcClient();
    expect(() => {
      client.parseResponse(JSON.stringify({ jsonrpc: '2.0', id: 1 }));
    }).toThrow('must contain result or error');
  });

  it('throws on response with both result and error', () => {
    const client = new JsonRpcClient();
    expect(() => {
      client.parseResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {}, error: { code: 1, message: 'err' } }));
    }).toThrow('must not contain both result and error');
  });

  it('frames a message with Content-Length header', () => {
    const client = new JsonRpcClient();
    const frame = client.frame({ jsonrpc: '2.0', method: 'test', id: 1 });
    expect(frame).toContain('Content-Length:');
    expect(frame).toContain('"method":"test"');
  });

  it('frame Content-Length matches actual body byte length for multi-byte chars', () => {
    const client = new JsonRpcClient();
    const frame = client.frame({ jsonrpc: '2.0', method: 'test', id: 1, params: { msg: '日本語' } });
    const headerMatch = frame.match(/^Content-Length: (\d+)\r\n\r\n/);
    expect(headerMatch).not.toBeNull();
    const declaredLength = parseInt(headerMatch![1], 10);
    const body = frame.replace(/^Content-Length: \d+\r\n\r\n/, '');
    expect(new TextEncoder().encode(body).length).toBe(declaredLength);
  });
});
