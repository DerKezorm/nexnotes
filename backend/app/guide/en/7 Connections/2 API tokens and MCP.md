---
icon: code
---
# API tokens and MCP

Programs such as n8n, Home Assistant or your own scripts work with your notes through an **API token**. AI tools connect through **MCP**.

![API tokens under Settings › Connections](shots/tokens.webp)

## Making a token

1. **Settings › Connections › New API token**.
2. Choose a name, the right (read only, or read and write), only certain folders if you like, and when it expires.
3. For AI tools tick **"Also for AI tools (MCP)"**.
4. Copy the token at once. It is shown only this one time.

![The dialog "New API token"](shots/token-dialog.webp)

You can revoke a token at any time; the program is locked out at once. Programs that connected themselves with your consent are listed under "Connected AI tools". The API documentation is linked from the token section.
