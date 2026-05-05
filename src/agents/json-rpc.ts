export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
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
  }
}

export class JsonRpcClient {
  private nextId = 1;

  createRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
    return { jsonrpc: '2.0', id: this.nextId++, method, params };
  }

  parseResponse(raw: string): { result: unknown } {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(raw);
    } catch (e) {
      throw new JsonRpcError(-32700, `Parse error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (response.error) {
      throw new JsonRpcError(response.error.code, response.error.message, response.error.data);
    }
    return { result: response.result };
  }

  frame(message: JsonRpcRequest | JsonRpcResponse): string {
    const content = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
  }
}
