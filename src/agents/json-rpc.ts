interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpcClient {
  private nextId = 1;

  createRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    };
  }

  parseResponse(raw: string): { result: unknown } {
    const response: JsonRpcResponse = JSON.parse(raw);
    if (response.error) {
      throw new Error(response.error.message);
    }
    return { result: response.result };
  }

  frame(message: object): string {
    const content = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
  }
}
