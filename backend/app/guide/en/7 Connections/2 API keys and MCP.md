---
icon: code
---
# API keys and MCP

Programs such as n8n, Home Assistant or your own scripts work with your notes through an **API key**. AI tools connect through **MCP**.

![API keys under Settings › My account › Connections](shots/tokens.webp)

## Creating a key

1. **Settings › My account › Connections › API keys**, there **"New API key"**.
2. Choose a name, the right ("Read only" or "Read and write"), only certain folders if you like, and when it expires.
3. For AI tools tick **"Also for AI tools (MCP)"**.
4. Copy the key at once. It is shown only this one time.

![The window "New API key"](shots/token-dialog.webp)

You can revoke a key at any time; the program is locked out at once. Programs that connected themselves with your consent are listed under Settings › My account › Connections › AI tools (MCP) at "Connected programs". The description of the interface is linked under Settings › My account › Connections › API keys.
