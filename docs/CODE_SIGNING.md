# Code Signing Setup

This guide covers code signing for each platform. Aelvyril binaries are unsigned by default — signing is required for distribution outside app stores.

## macOS (Apple Developer)

1. **Enroll** in the [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
2. **Create** a Developer ID Application certificate in Keychain Access → Certificate Assistant
3. **Export** as `.p12` (set a strong password)
4. **Set CI secrets** (GitHub Actions):
   - `APPLE_CERTIFICATE_BASE64` — `base64 -i certificate.p12 | pbcopy`
   - `APPLE_CERTIFICATE_PASSWORD` — the export password
   - `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Gene Gulanes (TEAM_ID)`
5. **Notarize** after signing:
   ```bash
   xcrun notarytool submit build/macos/Arelvyril.dmg \
     --apple-id "dev@example.com" \
     --team-id "TEAM_ID" \
     --password "@keychain:AC_PASSWORD" \
     --wait
   ```

### Tauri Config

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: ...",
      "entitlements": null,
      "hardenedRuntime": true
    }
  }
}
```

## Windows (Authenticode)

1. **Purchase** a Code Signing Certificate (DigiCert, Sectigo, GlobalSign)
2. **Export** as `.pfx` (with private key)
3. **Set CI secrets**:
   - `WINDOWS_CERTIFICATE_BASE64` — `base64 -w 0 certificate.pfx`
   - `WINDOWS_CERTIFICATE_PASSWORD` — the export password
4. **Sign** after build:
   ```bash
   signtool sign /f certificate.pfx /p "$PASSWORD" \
     /tr http://timestamp.digicert.com /td sha256 \
     /fd sha256 target/release/Aelvyril.exe
   ```

### Tauri Config

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": null,
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

## Linux

Linux doesn't require code signing for most distributions. For APT repo publishing:

1. **Create** a GPG key for package signing:
   ```bash
   gpg --full-generate-key  # RSA, 4096-bit
   gpg --export --armor > public.key
   ```
2. **Set CI secret**: `GPG_PRIVATE_KEY` — `base64 -w 0 private.key`
3. **Sign** `.deb` packages:
   ```bash
   dpkg-sig --sign builder --key-id KEY_ID aelvyril_0.1.0_amd64.deb
   ```

## CI Integration

The GitHub Actions workflow builds for all three platforms. Add signing steps after the build:

```yaml
# macOS
- name: Sign macOS binary
  if: matrix.os == 'macos-latest'
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE_BASE64 }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
  run: |
    echo $APPLE_CERTIFICATE | base64 --decode > /tmp/cert.p12
    security import /tmp/cert.p12 -k ~/Library/Keychains/login.keychain -P "$APPLE_CERTIFICATE_PASSWORD"

# Windows
- name: Sign Windows binary
  if: matrix.os == 'windows-latest'
  shell: pwsh
  env:
    CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE_BASE64 }}
    CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
  run: |
    [Convert]::FromBase64String($env:CERTIFICATE) | Set-Content -Path cert.pfx -Encoding Byte
    & signtool sign /f cert.pfx /p $env:CERTIFICATE_PASSWORD /tr http://timestamp.digicert.com /td sha256 target/release/Aelvyril.exe
```
