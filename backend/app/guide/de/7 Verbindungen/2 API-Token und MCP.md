---
icon: code
---
# API-Token und MCP

Programme wie n8n, Home Assistant oder eigene Skripte arbeiten über ein **API-Token** mit deinen Notizen. KI-Werkzeuge verbinden sich über **MCP**.

![API-Token unter Einstellungen › Verbindungen](shots/tokens.webp)

## Ein Token anlegen

1. **Einstellungen › Verbindungen › Neuer API-Token**.
2. Name, Recht (nur lesen oder lesen und schreiben), auf Wunsch nur bestimmte Ordner und ein Ablaufdatum wählen.
3. Für KI-Werkzeuge das Häkchen **„Auch für KI-Werkzeuge (MCP)“** setzen.
4. Den Token gleich kopieren. Er wird nur dieses eine Mal angezeigt.

![Der Dialog „Neuer API-Token“](shots/token-dialog.webp)

Ein Token kannst du jederzeit widerrufen; das Programm kommt dann sofort nicht mehr herein. Programme, die sich mit deiner Zustimmung selbst verbunden haben, stehen unter „Verbundene KI-Werkzeuge“. Die API-Dokumentation ist unter dem Token-Bereich verlinkt.
