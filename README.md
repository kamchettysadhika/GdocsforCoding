# GDocs4Coding

Real-time collaborative coding extension for Visual Studio Code, bringing Google Docs-like collaboration to your development workflow.

## Features

- **Real-time Collaboration**: Edit code simultaneously with multiple developers
- **Live Cursors**: See where your teammates are editing in real-time
- **Conflict Resolution**: Automatic handling of simultaneous edits
- **Session Management**: Easy session creation and joining
- **File Synchronization**: Share and sync files across all participants
- **Chat Integration**: Built-in chat for team communication
- **Follow Mode**: Follow other developers' actions and navigation

## Quick Start

1. **Start a session**: `Ctrl+Shift+L Ctrl+Shift+S`
2. **Share session ID** with your team
3. **Join session**: `Ctrl+Shift+L Ctrl+Shift+J`
4. **Collaborate** in real-time!

## Commands

- `GDocs4Coding: Start Session` - Create new collaboration session
- `GDocs4Coding: Join Session` - Join existing session
- `GDocs4Coding: Share File` - Share current file with participants
- `GDocs4Coding: Open Chat` - Open team chat panel

## Configuration

Configure through VS Code settings:
- Server URL for collaboration backend
- Display name for sessions
- Auto-follow new participants
- Cursor animation preferences

## Requirements

- VS Code 1.103.0+
- Network connection for real-time sync

## Installation

Install from the VS Code Extension Marketplace or package locally with `vsce package`.

## License

MIT
