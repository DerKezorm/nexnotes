---
icon: code
---
# API-Schlüssel und MCP

Programme wie n8n, Home Assistant oder eigene Skripte arbeiten über einen **API-Schlüssel** mit deinen Notizen. KI-Werkzeuge verbinden sich über **MCP**.

![API-Schlüssel unter Einstellungen › Mein Konto › Verbindungen](shots/tokens.webp)

## Einen Schlüssel anlegen

1. **Einstellungen › Mein Konto › Verbindungen › API-Schlüssel**, dort **„Neuer API-Schlüssel“**.
2. Name, Recht („Nur lesen“ oder „Lesen und schreiben“), auf Wunsch nur bestimmte Ordner und einen Ablauf wählen.
3. Für KI-Werkzeuge den Haken **„Auch für KI-Werkzeuge (MCP)“** setzen.
4. Den Schlüssel gleich kopieren. Er wird nur dieses eine Mal angezeigt.

![Das Fenster „Neuer API-Schlüssel“](shots/token-dialog.webp)

Einen Schlüssel kannst du jederzeit widerrufen; das Programm kommt dann sofort nicht mehr herein. Programme, die sich mit deiner Zustimmung selbst verbunden haben, stehen unter Einstellungen › Mein Konto › Verbindungen › KI-Werkzeuge (MCP) bei „Verbundene Programme“. Die Beschreibung der Schnittstelle ist unter Einstellungen › Mein Konto › Verbindungen › API-Schlüssel verlinkt.
