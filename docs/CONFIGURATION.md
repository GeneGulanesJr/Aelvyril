# Configuration Guide

## Environment Variables

Aelvyril supports several environment variables for configuration flexibility in different deployment scenarios.

### Presidio Service Configuration

The Presidio PII detection service can be configured with the following environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AELVYRIL_PRESIDIO_HOST` | `127.0.0.1` | Host address for the Presidio service |
| `AELVYRIL_PRESIDIO_PORT` | `3000` | Port for the Presidio service |

**Legacy Compatibility:**
- `PRESIDIO_HOST` and `PRESIDIO_PORT` are also supported for backward compatibility
- If both `AELVYRIL_*` and `PRESIDIO_*` are set, `AELVYRIL_*` takes precedence

### Usage Examples

#### Running on a specific interface
```bash
# Listen on all interfaces (useful for containerized deployments)
export AELVYRIL_PRESIDIO_HOST=0.0.0.0
export AELVYRIL_PRESIDIO_PORT=3000
cargo tauri dev
```

#### Running with a custom port
```bash
export AELVYRIL_PRESIDIO_PORT=8080
cargo tauri dev
```

#### Production deployment with Docker
```dockerfile
ENV AELVYRIL_PRESIDIO_HOST=0.0.0.0
ENV AELVYRIL_PRESIDIO_PORT=3000
```

### Security Considerations

- **Default (`127.0.0.1`)**: Most secure, only accessible from localhost
- **All interfaces (`0.0.0.0`)**: Required for containerized environments or network access
- **Specific IP**: Use when you need to bind to a particular network interface

### CSP Configuration

The Content Security Policy (CSP) in `src-tauri/tauri.conf.json` has been updated to support:
- Localhost connections (`127.0.0.1:*`, `[::1]:*`)
- Wildcard localhost connections (`localhost:*`)
- All interfaces (`http://0.0.0.0:*`)
- External API connections (Anthropic, OpenAI, Google, GitHub)

This ensures flexibility while maintaining security boundaries.

## Testing Configuration

All configuration changes have been tested to ensure:
1. ✅ No hardcoded localhost binding issues remain
2. ✅ Environment variables are properly respected
3. ✅ Error handling is robust (no `.unwrap()` panics in production)
4. ✅ CSP allows necessary connections while maintaining security
5. ✅ Backward compatibility is preserved

## Troubleshooting

### Port already in use
If you see "Address already in use" errors:
```bash
# Use a different port
export AELVYRIL_PRESIDIO_PORT=3001
cargo tauri dev
```

### Connection refused
Ensure the Presidio service host matches your network configuration:
- Local development: Use default `127.0.0.1` or `localhost`
- Docker containers: Set to `0.0.0.0` to accept connections from outside the container
- Network service: Set to the specific IP address of the host interface
