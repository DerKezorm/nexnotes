---
icon: code
---
# API-Schlüssel und MCP

Programme wie n8n, Home Assistant oder eigene Skripte arbeiten über einen **API-Schlüssel** mit deinen Notizen. KI-Werkzeuge verbinden sich über **MCP**. Für nextasks, nexlore und nextime brauchst du keinen Schlüssel, die verbindest du mit einem Klick.

![API-Schlüssel unter Einstellungen › Mein Konto › Verbindungen](shots/tokens.webp)

## Einen Schlüssel anlegen

1. **Einstellungen › Mein Konto › Verbindungen › API-Schlüssel**, dort **„Neuer API-Schlüssel“**.
2. Name, Recht („Nur lesen“ oder „Lesen und schreiben“), auf Wunsch nur bestimmte Ordner und einen Ablauf wählen.
3. Den Schlüssel gleich kopieren. Er wird nur dieses eine Mal angezeigt.

![Das Fenster „Neuer API-Schlüssel“](shots/token-dialog.webp)

Einen Schlüssel kannst du jederzeit widerrufen; das Programm kommt dann sofort nicht mehr herein. Die Beschreibung der Schnittstelle ist unter Einstellungen › Mein Konto › Verbindungen › API-Schlüssel verlinkt.

## KI-Werkzeuge (MCP)

Unter **Einstellungen › Mein Konto › Verbindungen › KI-Werkzeuge (MCP)** stehen bei „Verbundene Programme“ die KI-Werkzeuge, die sich mit deiner Zustimmung selbst verbunden haben, und darunter deine MCP-Schlüssel. Einen Schlüssel legst du mit **„Neuer MCP-Schlüssel“** an, mit Recht und auf Wunsch nur für bestimmte Ordner.

Unter **„Rechte je Werkzeug“** legst du für jeden Schlüssel und jedes Programm fest, was es tun darf: erlauben, fragen oder verweigern. Was fragt, wartet bei „Wartende Rückfragen“ auf dein Ja.

Gut zu wissen: Ältere API-Schlüssel mit dem Haken „Auch für KI-Werkzeuge (MCP)“ gelten weiter. Bei einer neuen Installation ist MCP aus; der Betreiber schaltet es unter Einstellungen › Server › Allgemein › Schnittstellen ein.
