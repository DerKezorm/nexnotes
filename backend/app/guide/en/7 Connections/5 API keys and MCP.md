---
icon: code
---
# API keys and MCP

Programs such as n8n, Home Assistant or your own scripts work with your notes through an **API key**. AI tools connect through **MCP**. nextasks, nexlore and nextime need no key; you connect them with one click.

![API keys under Settings › My account › Connections](shots/tokens.webp)

## Creating a key

1. **Settings › My account › Connections › API keys**, there **"New API key"**.
2. Choose a name, the right ("Read only" or "Read and write"), only certain folders if you like, and when it expires.
3. Copy the key at once. It is shown only this one time.

![The window "New API key"](shots/token-dialog.webp)

You can revoke a key at any time; the program is locked out at once. The description of the interface is linked under Settings › My account › Connections › API keys.

## AI tools (MCP)

Under **Settings › My account › Connections › AI tools (MCP)**, "Connected programs" lists the AI tools that connected themselves with your consent, and below them your MCP keys. You create a key with **"New MCP key"**, with a right and, if you like, for certain folders only.

Under **"Rights per tool"** you set for every key and program what it may do: allow, ask or deny. Whatever asks waits under "Waiting requests" for your yes.

Good to know: older API keys with the tick "Also for AI tools (MCP)" keep working. On a new installation MCP is off; the operator switches it on under Settings › Server › General › Interfaces.
