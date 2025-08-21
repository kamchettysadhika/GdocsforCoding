import * as vscode from 'vscode';
import * as WebSocket from 'ws';

let ws: WebSocket | null = null;
let roomId: string | null = null;
let statusBar: vscode.StatusBarItem;
let isLocalChange = false;
let outputChannel: vscode.OutputChannel;
let chatPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Enhanced Collab Code Editor is now active!');
    
    // Create output channel for code execution
    outputChannel = vscode.window.createOutputChannel('Collab Code Output');
    
    // Create status bar item
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.text = "$(broadcast) Start Collab";
    statusBar.command = 'collab-code-editor.startRoom';
    statusBar.show();

    // Register all commands
    const startRoomCommand = vscode.commands.registerCommand('collab-code-editor.startRoom', startRoom);
    const joinRoomCommand = vscode.commands.registerCommand('collab-code-editor.joinRoom', joinRoom);
    const leaveRoomCommand = vscode.commands.registerCommand('collab-code-editor.leaveRoom', leaveRoom);
    const executeCodeCommand = vscode.commands.registerCommand('collab-code-editor.executeCode', executeCode);
    const openChatCommand = vscode.commands.registerCommand('collab-code-editor.openChat', openChat);
    const shareRoomCommand = vscode.commands.registerCommand('collab-code-editor.shareRoom', shareRoom);

    // Listen for document changes
    const onDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument((event) => {
        if (!isLocalChange && ws && ws.readyState === WebSocket.OPEN && roomId) {
            const message = {
                type: 'documentChange',
                roomId: roomId,
                content: event.document.getText(),
                filename: event.document.fileName
            };
            ws.send(JSON.stringify(message));
        }
    });

    // Listen for cursor position changes
    const onDidChangeTextEditorSelection = vscode.window.onDidChangeTextEditorSelection((event) => {
        if (ws && ws.readyState === WebSocket.OPEN && roomId && event.textEditor.document) {
            const position = {
                line: event.selections[0].active.line,
                character: event.selections[0].active.character
            };
            
            const message = {
                type: 'cursorPosition',
                roomId: roomId,
                position: position
            };
            ws.send(JSON.stringify(message));
        }
    });

    context.subscriptions.push(
        startRoomCommand,
        joinRoomCommand,
        leaveRoomCommand,
        executeCodeCommand,
        openChatCommand,
        shareRoomCommand,
        statusBar,
        outputChannel,
        onDidChangeTextDocument,
        onDidChangeTextEditorSelection
    );
}

async function startRoom() {
    try {
        roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        
        ws = new WebSocket('ws://localhost:8000');
        
        ws.on('open', () => {
            console.log('Connected to enhanced collaboration server');
            const message = {
                type: 'join',
                roomId: roomId,
                username: getUsername()
            };
            ws!.send(JSON.stringify(message));
            
            updateStatusBar();
            setupMessageHandlers();
            showWelcomeMessage();
        });
        
        ws.on('error', (error) => {
            vscode.window.showErrorMessage(`Connection failed: ${error.message}`);
        });
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to start room: ${error}`);
    }
}

async function joinRoom() {
    const inputRoomId = await vscode.window.showInputBox({
        prompt: 'Enter room ID to join',
        placeholder: 'ABC123'
    });
    
    if (!inputRoomId) return;
    
    roomId = inputRoomId.toUpperCase();
    
    try {
        ws = new WebSocket('ws://localhost:8000');
        
        ws.on('open', () => {
            const message = {
                type: 'join',
                roomId: roomId,
                username: getUsername()
            };
            ws!.send(JSON.stringify(message));
            
            updateStatusBar();
            setupMessageHandlers();
            vscode.window.showInformationMessage(`Joined room ${roomId}! 🎉`);
        });
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to join room: ${error}`);
    }
}

function setupMessageHandlers() {
    if (!ws) return;
    
    ws.on('message', (data: WebSocket.Data) => {
        try {
            const message = JSON.parse(data.toString());
            
            switch (message.type) {
                case 'documentUpdate':
                    applyDocumentUpdate(message.content, message.filename);
                    break;
                
                case 'cursorUpdate':
                    showCursorPosition(message.userId, message.position);
                    break;
                
                case 'userJoined':
                    vscode.window.showInformationMessage(
                        `${message.username} joined the session! (${message.userCount} users)`
                    );
                    break;
                
                case 'userLeft':
                    vscode.window.showInformationMessage(
                        `User left the session (${message.userCount} users remaining)`
                    );
                    break;
                
                case 'executionResult':
                    showExecutionResult(message.result);
                    break;
                
                case 'chatMessage':
                    showChatMessage(message);
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });
}

async function executeCode() {
    if (!ws || !roomId) {
        vscode.window.showWarningMessage('Not connected to a collaboration room');
        return;
    }
    
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
    }
    
    const selection = editor.selection;
    const code = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
    
    if (!code.trim()) {
        vscode.window.showWarningMessage('No code to execute');
        return;
    }
    
    // Detect language from file extension
    const language = getLanguageFromDocument(editor.document);
    
    vscode.window.showInformationMessage('🚀 Executing code...');
    outputChannel.appendLine(`\n=== Executing ${language} Code ===`);
    outputChannel.appendLine(code);
    outputChannel.appendLine('=== Output ===');
    outputChannel.show();
    
    const message = {
        type: 'executeCode',
        roomId: roomId,
        code: code,
        language: language
    };
    
    ws.send(JSON.stringify(message));
}

function showExecutionResult(result: any) {
    if (result.success) {
        outputChannel.appendLine(`✅ Success:\n${result.output}`);
        vscode.window.showInformationMessage('Code executed successfully! Check output panel.');
    } else {
        outputChannel.appendLine(`❌ Error:\n${result.error}`);
        vscode.window.showErrorMessage('Code execution failed! Check output panel.');
    }
    outputChannel.appendLine('=== End ===\n');
}

async function openChat() {
    if (!roomId) {
        vscode.window.showWarningMessage('Not connected to a collaboration room');
        return;
    }
    
    if (chatPanel) {
        chatPanel.reveal();
        return;
    }
    
    chatPanel = vscode.window.createWebviewPanel(
        'collabChat',
        `Chat - Room ${roomId}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );
    
    chatPanel.webview.html = getChatHtml();
    
    chatPanel.webview.onDidReceiveMessage(message => {
        if (message.type === 'sendMessage' && ws) {
            const chatMessage = {
                type: 'chatMessage',
                roomId: roomId,
                message: message.text,
                username: getUsername()
            };
            ws.send(JSON.stringify(chatMessage));
        }
    });
    
    chatPanel.onDidDispose(() => {
        chatPanel = undefined;
    });
}

function showChatMessage(message: any) {
    if (chatPanel) {
        chatPanel.webview.postMessage({
            type: 'newMessage',
            username: message.username,
            message: message.message,
            timestamp: message.timestamp,
            isOwnMessage: false
        });
    }
}

async function shareRoom() {
    if (!roomId) {
        vscode.window.showWarningMessage('No active collaboration room');
        return;
    }
    
    const shareUrl = `vscode://collab-code-editor/join?room=${roomId}`;
    
    const choice = await vscode.window.showInformationMessage(
        `Share Room ${roomId}`,
        'Copy Room ID',
        'Copy VS Code Link'
    );
    
    if (choice === 'Copy Room ID') {
        await vscode.env.clipboard.writeText(roomId);
        vscode.window.showInformationMessage('Room ID copied to clipboard!');
    } else if (choice === 'Copy VS Code Link') {
        await vscode.env.clipboard.writeText(shareUrl);
        vscode.window.showInformationMessage('VS Code link copied to clipboard!');
    }
}

// Helper functions
function updateStatusBar() {
    if (!roomId) {
        statusBar.text = "$(broadcast) Start Collab";
        statusBar.command = 'collab-code-editor.startRoom';
    } else {
        statusBar.text = `$(sync) Room: ${roomId}`;
        statusBar.command = 'collab-code-editor.shareRoom';
        statusBar.tooltip = 'Click to share room';
    }
}

function applyDocumentUpdate(content: string, filename: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    
    isLocalChange = true;
    editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
        );
        editBuilder.replace(fullRange, content);
    }).then(() => {
        isLocalChange = false;
    });
}

function showCursorPosition(userId: string, position: any) {
    // Visual indicator for other users' cursors
    // This could be enhanced with decorations
    console.log(`User ${userId} cursor at line ${position.line}, character ${position.character}`);
}

function getLanguageFromDocument(document: vscode.TextDocument): string {
    const extension = document.fileName.split('.').pop()?.toLowerCase();
    switch (extension) {
        case 'py': return 'python';
        case 'js': case 'jsx': return 'javascript';
        case 'ts': case 'tsx': return 'typescript';
        case 'java': return 'java';
        case 'cpp': case 'cc': case 'cxx': return 'cpp';
        case 'c': return 'c';
        case 'go': return 'go';
        case 'rs': return 'rust';
        default: return document.languageId || 'python';
    }
}

function getUsername(): string {
    return process.env.USER || process.env.USERNAME || 'User';
}

function showWelcomeMessage() {
    vscode.window.showInformationMessage(
        `🎉 Room ${roomId} created! Share with others to collaborate.`,
        'Share Room', 'Open Chat', 'Execute Code'
    ).then(choice => {
        switch (choice) {
            case 'Share Room': shareRoom(); break;
            case 'Open Chat': openChat(); break;
            case 'Execute Code': executeCode(); break;
        }
    });
}

async function leaveRoom() {
    if (ws) {
        ws.close();
        ws = null;
    }
    roomId = null;
    updateStatusBar();
    
    if (chatPanel) {
        chatPanel.dispose();
        chatPanel = undefined;
    }
    
    vscode.window.showInformationMessage('Left collaboration room');
}

function getChatHtml(): string {
    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: var(--vscode-font-family); padding: 10px; }
            #messages { height: 300px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); padding: 10px; margin-bottom: 10px; }
            #input { width: 100%; padding: 5px; }
            .message { margin-bottom: 10px; }
            .username { font-weight: bold; color: var(--vscode-textLink-foreground); }
            .timestamp { font-size: 0.8em; color: var(--vscode-descriptionForeground); }
        </style>
    </head>
    <body>
        <div id="messages"></div>
        <input type="text" id="input" placeholder="Type a message..." />
        
        <script>
            const vscode = acquireVsCodeApi();
            const messages = document.getElementById('messages');
            const input = document.getElementById('input');
            
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && input.value.trim()) {
                    vscode.postMessage({ type: 'sendMessage', text: input.value });
                    addMessage('You', input.value, new Date().toISOString(), true);
                    input.value = '';
                }
            });
            
            window.addEventListener('message', (event) => {
                const message = event.data;
                if (message.type === 'newMessage') {
                    addMessage(message.username, message.message, message.timestamp, message.isOwnMessage);
                }
            });
            
            function addMessage(username, message, timestamp, isOwn) {
                const div = document.createElement('div');
                div.className = 'message';
                const time = new Date(timestamp).toLocaleTimeString();
                div.innerHTML = \`<span class="username">\${username}:</span> \${message} <span class="timestamp">[\${time}]</span>\`;
                messages.appendChild(div);
                messages.scrollTop = messages.scrollHeight;
            }
        </script>
    </body>
    </html>`;
}

export function deactivate() {
    if (ws) {
        ws.close();
    }
}