export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpcError extends Error {
  code: number;
  data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, JsonRpcError.prototype);
  }
}

export class JsonRpcClient {
  private nextId = 1;

  createRequest(method: string, params?: Record<string, unknown> | unknown[]): JsonRpcRequest {
    return { jsonrpc: '2.0', id: this.nextId++, method, params };
  }

  parseResponse(raw: string): { result: unknown } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new JsonRpcError(-32700, `Parse error: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (typeof parsed !== 'object' || parsed === null || !('jsonrpc' in parsed)) {
      throw new JsonRpcError(-32600, 'Invalid Request: missing jsonrpc field');
    }
    const response = parsed as Record<string, unknown>;
    if (response.jsonrpc !== '2.0') {
      throw new JsonRpcError(-32600, 'Invalid Request: unsupported jsonrpc version');
    }
    if (!('id' in response)) {
      throw new JsonRpcError(-32600, 'Invalid Request: missing id');
    }

    const hasResult = 'result' in response;
    const hasError = 'error' in response;
    if (!hasResult && !hasError) {
      throw new JsonRpcError(-32600, 'Invalid Request: response must contain result or error');
    }
    if (hasResult && hasError) {
      throw new JsonRpcError(-32600, 'Invalid Request: response must not contain both result and error');
    }

    if (hasError) {
      const err = response.error as { code: number; message: string; data?: unknown };
      throw new JsonRpcError(err.code, err.message, err.data);
    }

    return { result: response.result };
  }

  frame(message: JsonRpcRequest | JsonRpcResponse): string {
    const content = JSON.stringify(message);
    const byteLength = new TextEncoder().encode(content).length;
    return `Content-Length: ${byteLength}\r\n\r\n${content}`;
  }
}
