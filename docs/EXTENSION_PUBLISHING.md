# Browser Extension Publishing Guide

The Aelvyril browser extension intercepts copy-paste events in web pages and scans clipboard content before it reaches AI tools. It communicates with the desktop app via a local WebSocket bridge.

## Pre-Publish Checklist

- [ ] Verify extension works with the latest gateway version
- [ ] Test on Chrome (latest), Firefox (latest), Edge (latest)
- [ ] Ensure all permissions are minimal and justified
- [ ] Verify icons at 16, 48, 128px are present
- [ ] Check that `manifest.json` version matches the desktop app version
- [ ] Privacy policy URL is set (links to GitHub README privacy section)

## Chrome Web Store

### Developer Account
1. Go to [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. One-time fee: $5 USD
3. Sign in with the Google account that owns the listing

### Requirements
- Manifest V3 format (already implemented)
- ZIP the `extension/` directory (not the parent)
- All icons as PNG (16, 48, 128px)
- Description: max 132 characters for short description, 3200 for detailed
- Privacy policy URL
- Screenshots: 1280x800 or 640x400, PNG or JPEG

### Submission Steps
1. Click "New item" in the Developer Dashboard
2. Upload the ZIP file
3. Fill in listing details:
   - Name: Aelvyril
   - Summary: "Privacy gateway that scans clipboard content for PII before it reaches AI tools"
   - Description: detailed explanation of what it does
   - Category: Productivity
   - Language: English (add more as translations are completed)
4. Upload screenshots (at least 1, max 5)
5. Set pricing: Free
6. Select visibility: Public
7. Submit for review (typically 1-3 business days)

## Firefox Add-ons (AMO)

### Developer Account
1. Go to [AMO Developer Hub](https://addons.mozilla.org/developers/)
2. Free — no fee required
3. Sign in or create a Firefox Account

### Requirements
- Manifest V2 or V3 (MV3 preferred, Firefox 109+)
- ZIP the `extension/` directory
- Source code: provide GitHub URL or upload source
- Review type: standard review (automatic for most extensions)

### Submission Steps
1. Click "Submit a New Add-on" on the Developer Hub
2. Upload the ZIP file
3. Select "On this site" for distribution
4. Source code: provide GitHub repository URL
5. Fill in listing details:
   - Name: Aelvyril
   - Summary: brief description (max 250 chars)
   - Description: detailed explanation
   - Categories: Productivity, Security & Privacy
   - License: MIT (matching the repository)
6. Upload screenshots (at least 1)
7. Submit for review (typically 1-7 business days)

## Version Management

Keep the extension version in sync with the desktop app:

1. Update `version` in `extension/manifest.json`
2. Update `version_name` for human-readable display
3. Tag the release in Git: `git tag v0.1.0`
4. Upload updated ZIP to both stores

## Post-Publish Monitoring

- [ ] Monitor store reviews for bug reports and feature requests
- [ ] Watch for compatibility issues with browser updates
- [ ] Track install count and active users
- [ ] Respond to user reviews promptly
- [ ] Test each new gateway version against the published extension
