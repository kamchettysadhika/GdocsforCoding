import * as vscode from 'vscode';
import * as WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

// Types and interfaces
interface User {
    id: string;
    username: string;
    color: string;
    cursor?: vscode.Position;
    selection?: vscode.Range;
    activeFile?: string;
    isFollowing?: boolean;
}

interface CollaborationSession {
    id: string;
    hostId: string;
    users: Map<string, User>;
    sharedFiles: Set<string>;
    isHost: boolean;
    sharedServers: Map<number, string>; // port -> name
    activeTerminals: Set<string>;
}

interface DocumentOperation {
    type: 'insert' | 'delete' | 'replace';
    range: vscode.Range;
    text: string;
    timestamp: number;
    userId: string;
    operationId: string; // For conflict resolution
}

interface ServerInfo {
    port: number;
    name: string;
    url: string;
}

interface ChatMessage {
    id: string;
    userId: string;
    username: string;
    message: string;
    timestamp: string;
    type: 'text' | 'file' | 'code';
    metadata?: any;
}

class OperationalTransform {
    static transform(op1: DocumentOperation, op2: DocumentOperation): DocumentOperation[] {
        // Simplified OT - in production, use a proper OT library
        if (op1.timestamp < op2.timestamp) {
            return [op1];
        }
        return [op2];
    }
}

class LiveShareManager {
    private ws: WebSocket | null = null;
    private session: CollaborationSession | null = null;
    private userId: string;
    private username: string;
    private statusBar!: vscode.StatusBarItem;
    private outputChannel!: vscode.OutputChannel;
    private chatPanel: vscode.WebviewPanel | undefined;
    private userColors: string[] = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8'];
    private isLocalChange = false;
    private documentDecorations: Map<string, vscode.TextEditorDecorationType[]> = new Map();
    private presencePanel: vscode.WebviewPanel | undefined;
    private chatMessages: ChatMessage[] = [];
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectTimer?: NodeJS.Timeout;
    private followingUserId?: string;
    private operationQueue: DocumentOperation[] = [];
    private isProcessingOperations = false;

    constructor(private context: vscode.ExtensionContext) {
        this.userId = uuidv4();
        this.username = this.getUsername();
        this.setupStatusBar();
        this.setupOutputChannel();
        this.registerCommands();
        this.setupEventListeners();
        this.loadSettings();
    }

    private loadSettings() {
        const config = vscode.workspace.getConfiguration('liveshare');
        
        // Override username if set in config
        const configUsername = config.get<string>('username');
        if (configUsername && configUsername.trim()) {
            this.username = configUsername.trim();
        }
        
        // Load other settings
        this.maxReconnectAttempts = config.get<number>('maxReconnectAttempts', 5);
    }

    private setupStatusBar() {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBar.text = "$(live-share) Start Live Share";
        this.statusBar.command = 'liveshare.startSession';
        this.statusBar.tooltip = 'Start a Live Share session';
        this.statusBar.show();
        this.context.subscriptions.push(this.statusBar);
    }

    private setupOutputChannel() {
        this.outputChannel = vscode.window.createOutputChannel('Live Share');
        this.context.subscriptions.push(this.outputChannel);
    }

    private registerCommands() {
        const commands = [
            vscode.commands.registerCommand('liveshare.startSession', () => this.startSession()),
            vscode.commands.registerCommand('liveshare.joinSession', () => this.joinSession()),
            vscode.commands.registerCommand('liveshare.endSession', () => this.endSession()),
            vscode.commands.registerCommand('liveshare.shareTerminal', () => this.shareTerminal()),
            vscode.commands.registerCommand('liveshare.openChat', () => this.openChat()),
            vscode.commands.registerCommand('liveshare.showPresence', () => this.showPresence()),
            vscode.commands.registerCommand('liveshare.shareFile', () => this.shareCurrentFile()),
            vscode.commands.registerCommand('liveshare.followUser', () => this.followUser()),
            vscode.commands.registerCommand('liveshare.stopFollowing', () => this.stopFollowing()),
            vscode.commands.registerCommand('liveshare.executeCode', () => this.executeSharedCode()),
            vscode.commands.registerCommand('liveshare.shareServer', () => this.shareLocalServer()),
            vscode.commands.registerCommand('liveshare.unshareFile', () => this.unshareCurrentFile()),
            vscode.commands.registerCommand('liveshare.focusUser', (userId: string) => this.focusOnUser(userId)),
            vscode.commands.registerCommand('liveshare.shareSelection', () => this.shareSelection()),
            vscode.commands.registerCommand('liveshare.toggleReadOnly', () => this.toggleReadOnlyMode()),
            vscode.commands.registerCommand('liveshare.exportSession', () => this.exportSession()),
            vscode.commands.registerCommand('liveshare.showSettings', () => this.showSettings())
        ];

        commands.forEach(cmd => this.context.subscriptions.push(cmd));
        
        // Set initial context values
        this.updateContext();
    }

    private updateContext() {
        vscode.commands.executeCommand('setContext', 'liveshare.sessionActive', !!this.session);
        vscode.commands.executeCommand('setContext', 'liveshare.isHost', this.session?.isHost || false);
        vscode.commands.executeCommand('setContext', 'liveshare.following', !!this.followingUserId);
    }
    private handleTerminalOutput(message: any) {
        const timestamp = new Date().toLocaleTimeString();
        const user = this.session?.users.get(message.userId);
        const username = user?.username ?? 'Unknown User';
    
        // Expecting: message.terminalId, message.output (string), message.isError? (bool)
        const heading = `\n[${timestamp}] 🖥️ Terminal ${message.terminalId} • ${username}`;
        this.outputChannel.appendLine(heading);
        if (message.isError) {
            this.outputChannel.appendLine(`stderr: ${message.output}`);
        } else {
            this.outputChannel.appendLine(message.output);
        }
        this.outputChannel.show(true);
    }
    

    private setupEventListeners() {
        // Document change listener with debouncing
        let changeTimeout: NodeJS.Timeout;
        const onDocumentChange = vscode.workspace.onDidChangeTextDocument((event) => {
            if (!this.isLocalChange && this.session && this.ws) {
                clearTimeout(changeTimeout);
                changeTimeout = setTimeout(() => {
                    this.handleLocalDocumentChange(event);
                }, 50); // Debounce rapid changes
            }
        });

        // Cursor/selection change listener with throttling
        let selectionTimeout: NodeJS.Timeout;
        const onSelectionChange = vscode.window.onDidChangeTextEditorSelection((event) => {
            if (this.session && this.ws && event.textEditor.document) {
                clearTimeout(selectionTimeout);
                selectionTimeout = setTimeout(() => {
                    this.handleCursorChange(event);
                }, 100); // Throttle cursor updates
            }
        });

        // File open/close listeners
        const onFileOpen = vscode.workspace.onDidOpenTextDocument((document) => {
            if (this.session && this.session.sharedFiles.has(document.uri.toString())) {
                this.requestFileContent(document.uri.toString());
            }
        });

        const onFileClose = vscode.workspace.onDidCloseTextDocument((document) => {
            if (this.session) {
                this.sendMessage({
                    type: 'fileClose',
                    sessionId: this.session.id,
                    userId: this.userId,
                    uri: document.uri.toString()
                });
            }
        });

        // Active editor change
        const onActiveEditorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (this.session && this.ws && editor) {
                this.sendMessage({
                    type: 'activeFileChange',
                    sessionId: this.session.id,
                    userId: this.userId,
                    filename: editor.document.fileName,
                    uri: editor.document.uri.toString()
                });

                // Update following behavior
                if (this.followingUserId) {
                    this.stopFollowing();
                }
            }
        });

        // Window focus changes
        const onWindowFocusChange = vscode.window.onDidChangeWindowState((state) => {
            if (this.session && this.ws) {
                this.sendMessage({
                    type: 'userPresence',
                    sessionId: this.session.id,
                    userId: this.userId,
                    focused: state.focused
                });
            }
        });

        this.context.subscriptions.push(
            onDocumentChange, 
            onSelectionChange, 
            onFileOpen, 
            onFileClose, 
            onActiveEditorChange,
            onWindowFocusChange
        );
    }

    private async requestFileContent(uri: string) {
        if (!this.ws || !this.session) return;

        this.sendMessage({
            type: 'requestFileContent',
            sessionId: this.session.id,
            userId: this.userId,
            uri: uri
        });
    }

    async startSession() {
        try {
            const sessionId = this.generateSessionId();
            
            // Get server URL from configuration
            const config = vscode.workspace.getConfiguration('liveshare');
            const serverUrl = config.get<string>('serverUrl', 'ws://localhost:8000');
            
            // Show progress indicator
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Starting Live Share session...",
                cancellable: true
            }, async (progress, token) => {
                return new Promise((resolve, reject) => {
                    // Connect to collaboration server
                    this.ws = new WebSocket(serverUrl);
                    
                    this.ws.on('open', () => {
                        this.session = {
                            id: sessionId,
                            hostId: this.userId,
                            users: new Map(),
                            sharedFiles: new Set(),
                            isHost: true,
                            sharedServers: new Map(),
                            activeTerminals: new Set()
                        };

                        this.sendMessage({
                            type: 'createSession',
                            sessionId: sessionId,
                            userId: this.userId,
                            username: this.username,
                            capabilities: this.getCapabilities()
                        });

                        this.updateStatusBar();
                        this.updateContext();
                        this.setupMessageHandlers();
                        this.showSessionStartedMessage();
                        this.logActivity(`Session ${sessionId} started`);
                        resolve(undefined);
                    });

                    this.ws.on('error', (error) => {
                        this.logActivity(`Connection error: ${error.message}`, 'error');
                        reject(error);
                    });

                    token.onCancellationRequested(() => {
                        if (this.ws) {
                            this.ws.close();
                        }
                        reject(new Error('Cancelled by user'));
                    });
                });
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to start session: ${error}`);
            this.cleanup();
        }
    }

    async joinSession() {
        const sessionId = await vscode.window.showInputBox({
            prompt: 'Enter Live Share session ID',
            placeHolder: 'e.g., ABC123',
            validateInput: (value) => {
                if (!value || value.length < 6) {
                    return 'Session ID must be at least 6 characters';
                }
                if (!/^[A-Z0-9]+$/.test(value)) {
                    return 'Session ID can only contain uppercase letters and numbers';
                }
                return null;
            }
        });

        if (!sessionId) return;

        try {
            // Get server URL from configuration
            const config = vscode.workspace.getConfiguration('liveshare');
            const serverUrl = config.get<string>('serverUrl', 'ws://localhost:8000');
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Joining session ${sessionId}...`,
                cancellable: true
            }, async (progress, token) => {
                return new Promise((resolve, reject) => {
                    this.ws = new WebSocket(serverUrl);
                    
                    this.ws.on('open', () => {
                        this.session = {
                            id: sessionId,
                            hostId: '', // Will be set by server
                            users: new Map(),
                            sharedFiles: new Set(),
                            isHost: false,
                            sharedServers: new Map(),
                            activeTerminals: new Set()
                        };

                        this.sendMessage({
                            type: 'joinSession',
                            sessionId: sessionId,
                            userId: this.userId,
                            username: this.username,
                            capabilities: this.getCapabilities()
                        });

                        this.updateStatusBar();
                        this.updateContext();
                        this.setupMessageHandlers();
                        this.logActivity(`Joined session ${sessionId}`);
                        resolve(undefined);
                    });

                    this.ws.on('error', (error) => {
                        reject(error);
                    });

                    token.onCancellationRequested(() => {
                        if (this.ws) {
                            this.ws.close();
                        }
                        reject(new Error('Cancelled by user'));
                    });
                });
            });

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to join session: ${error}`);
            this.cleanup();
        }
    }

    private getCapabilities() {
        return {
            canExecuteCode: true,
            canShareTerminal: true,
            canShareServer: true,
            supportedLanguages: ['javascript', 'typescript', 'python', 'java', 'cpp', 'c', 'go', 'rust'],
            version: '1.0.0'
        };
    }

    private setupMessageHandlers() {
        if (!this.ws) return;

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            } catch (error) {
                this.logActivity(`Error parsing message: ${error}`, 'error');
            }
        });

        this.ws.on('close', (code, reason) => {
            this.logActivity(`Connection closed: ${code} - ${reason}`, 'warn');
            this.handleDisconnection();
        });

        this.ws.on('error', (error) => {
            this.logActivity(`WebSocket error: ${error.message}`, 'error');
        });
    }

    private handleDisconnection() {
        if (this.session && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.logActivity(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`, 'warn');
            
            this.reconnectTimer = setTimeout(() => {
                this.attemptReconnect();
            }, Math.pow(2, this.reconnectAttempts) * 1000); // Exponential backoff
        } else {
            vscode.window.showWarningMessage('Live Share session disconnected');
            this.cleanup();
        }
    }

    private async attemptReconnect() {
        if (!this.session) return;

        try {
            // Get server URL from configuration  
            const config = vscode.workspace.getConfiguration('liveshare');
            const serverUrl = config.get<string>('serverUrl', 'ws://localhost:8000');
            
            this.ws = new WebSocket(serverUrl);
            this.setupMessageHandlers();
            
            this.ws.on('open', () => {
                this.sendMessage({
                    type: 'rejoinSession',
                    sessionId: this.session!.id,
                    userId: this.userId,
                    username: this.username
                });
                
                this.reconnectAttempts = 0;
                this.logActivity('Reconnected successfully!');
                vscode.window.showInformationMessage('Live Share session reconnected');
            });
        } catch (error) {
            this.logActivity(`Reconnection failed: ${error}`, 'error');
            this.handleDisconnection();
        }
    }

    private handleMessage(message: any) {
        switch (message.type) {
            case 'sessionCreated':
                this.handleSessionCreated(message);
                break;
            case 'sessionJoined':
                this.handleSessionJoined(message);
                break;
            case 'userJoined':
                this.handleUserJoined(message);
                break;
            case 'userLeft':
                this.handleUserLeft(message);
                break;
            case 'documentOperation':
                this.queueDocumentOperation(message);
                break;
            case 'cursorUpdate':
                this.handleCursorUpdate(message);
                break;
            case 'fileShared':
                this.handleFileShared(message);
                break;
            case 'fileUnshared':
                this.handleFileUnshared(message);
                break;
            case 'fileContent':
                this.handleFileContent(message);
                break;
            case 'chatMessage':
                this.handleChatMessage(message);
                break;
            case 'codeExecution':
                this.handleCodeExecution(message);
                break;
            case 'activeFileChange':
                this.handleActiveFileChange(message);
                break;
            case 'terminalOutput':
                this.handleTerminalOutput(message);
                break;
            case 'serverShared':
                this.handleServerShared(message);
                break;
            case 'userPresence':
                this.handleUserPresence(message);
                break;
            case 'sessionError':
                this.handleSessionError(message);
                break;
            case 'followUser':
                this.handleFollowUser(message);
                break;
        }
    }

    private queueDocumentOperation(message: any) {
        this.operationQueue.push(message);
        this.processOperationQueue();
    }

    private async processOperationQueue() {
        if (this.isProcessingOperations || this.operationQueue.length === 0) {
            return;
        }

        this.isProcessingOperations = true;

        while (this.operationQueue.length > 0) {
            const message = this.operationQueue.shift()!;
            await this.handleDocumentOperation(message);
        }

        this.isProcessingOperations = false;
    }

    private async handleDocumentOperation(message: any) {
        this.isLocalChange = true;
        
        try {
            const editor = vscode.window.visibleTextEditors.find(
                e => e.document.uri.toString() === message.uri
            );

            if (editor) {
                const success = await editor.edit(editBuilder => {
                    const range = new vscode.Range(
                        message.operation.range.start.line,
                        message.operation.range.start.character,
                        message.operation.range.end.line,
                        message.operation.range.end.character
                    );

                    switch (message.operation.type) {
                        case 'insert':
                            editBuilder.insert(range.start, message.operation.text);
                            break;
                        case 'delete':
                            editBuilder.delete(range);
                            break;
                        case 'replace':
                            editBuilder.replace(range, message.operation.text);
                            break;
                    }
                });

                if (!success) {
                    this.logActivity('Failed to apply document operation', 'error');
                }
            }
        } catch (error) {
            this.logActivity(`Error applying document operation: ${error}`, 'error');
        } finally {
            this.isLocalChange = false;
        }
    }

    private handleSessionCreated(message: any) {
        const actions = ['Copy Session ID', 'Share Link', 'Open Chat', 'Show Settings'];
        vscode.window.showInformationMessage(
            `Live Share session created! Session ID: ${message.sessionId}`,
            ...actions
        ).then(choice => {
            switch (choice) {
                case 'Copy Session ID':
                    vscode.env.clipboard.writeText(message.sessionId);
                    vscode.window.showInformationMessage('Session ID copied to clipboard!');
                    break;
                case 'Share Link':
                    this.shareSessionLink();
                    break;
                case 'Open Chat':
                    this.openChat();
                    break;
                case 'Show Settings':
                    this.showSettings();
                    break;
            }
        });
    }

    private handleSessionJoined(message: any) {
        if (message.sharedFiles) {
            message.sharedFiles.forEach((file: string) => {
                this.session!.sharedFiles.add(file);
            });
        }

        if (message.users) {
            message.users.forEach((user: User) => {
                this.session!.users.set(user.id, user);
            });
        }

        this.updatePresencePanel();
        vscode.window.showInformationMessage(`Joined Live Share session: ${message.sessionId}`);
    }

    private handleUserJoined(message: any) {
        const user: User = {
            id: message.userId,
            username: message.username,
            color: this.userColors[this.session!.users.size % this.userColors.length],
            isFollowing: false
        };

        this.session!.users.set(message.userId, user);
        
        // Show notification with actions
        vscode.window.showInformationMessage(
            `${message.username} joined the session! 👋`,
            'Follow User', 'Open Chat'
        ).then(choice => {
            if (choice === 'Follow User') {
                this.startFollowingUser(message.userId);
            } else if (choice === 'Open Chat') {
                this.openChat();
            }
        });
        
        this.updatePresencePanel();
        this.logActivity(`${message.username} joined the session`);
    }

    private handleUserLeft(message: any) {
        const user = this.session?.users.get(message.userId);
        if (user) {
            this.session!.users.delete(message.userId);
            vscode.window.showInformationMessage(`${user.username} left the session`);
            
            // Stop following if following this user
            if (this.followingUserId === message.userId) {
                this.stopFollowing();
            }
        }
        
        this.updatePresencePanel();
        this.logActivity(`User ${message.userId} left the session`);
    }

    private handleCursorUpdate(message: any) {
        const user = this.session?.users.get(message.userId);
        if (!user) return;

        if (message.cursor) {
            user.cursor = new vscode.Position(message.cursor.line, message.cursor.character);
        }
        
        if (message.selection) {
            user.selection = new vscode.Range(
                message.selection.start.line,
                message.selection.start.character,
                message.selection.end.line,
                message.selection.end.character
            );
        }

        this.updateCursorDecorations(message.uri);
        this.updatePresencePanel();
    }

    private handleFileShared(message: any) {
        this.session!.sharedFiles.add(message.uri);
        
        vscode.window.showInformationMessage(
            `${message.username} shared: ${message.filename}`,
            'Open File'
        ).then(choice => {
            if (choice === 'Open File') {
                this.openSharedFile(message.uri, message.content);
            }
        });
        
        this.logActivity(`File shared: ${message.filename}`);
    }

    private handleFileUnshared(message: any) {
        this.session!.sharedFiles.delete(message.uri);
        vscode.window.showInformationMessage(`File unshared: ${message.filename}`);
        this.logActivity(`File unshared: ${message.filename}`);
    }

    private async handleFileContent(message: any) {
        try {
            await this.openSharedFile(message.uri, message.content);
        } catch (error) {
            this.logActivity(`Failed to open shared file: ${error}`, 'error');
        }
    }

    private async openSharedFile(uri: string, content: string) {
        try {
            const parsedUri = vscode.Uri.parse(uri);
            const document = await vscode.workspace.openTextDocument({
                content: content,
                language: this.getLanguageFromUri(uri)
            });
            
            await vscode.window.showTextDocument(document);
        } catch (error) {
            this.logActivity(`Error opening shared file: ${error}`, 'error');
        }
    }

    private handleActiveFileChange(message: any) {
        const user = this.session?.users.get(message.userId);
        if (user) {
            user.activeFile = message.uri;
            this.updatePresencePanel();
        }

        // If following this user, switch to their active file
        if (this.followingUserId === message.userId) {
            this.followUserToFile(message.uri);
        }
    }

    private async followUserToFile(uri: string) {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
            await vscode.window.showTextDocument(document);
        } catch (error) {
            this.logActivity(`Failed to follow user to file: ${error}`, 'error');
        }
    }

    private handleChatMessage(message: any) {
        const chatMessage: ChatMessage = {
            id: uuidv4(),
            userId: message.userId,
            username: message.username,
            message: message.message,
            timestamp: message.timestamp,
            type: message.messageType || 'text',
            metadata: message.metadata
        };

        this.chatMessages.push(chatMessage);

        // Update chat panel if open
        if (this.chatPanel) {
            this.chatPanel.webview.postMessage({
                evt: 'newMessage',
                ...chatMessage
            });
        }

        // Show notification for important messages
        if (chatMessage.type === 'code' || message.mentioned) {
            vscode.window.showInformationMessage(
                `💬 ${message.username}: ${message.message.substring(0, 50)}...`,
                'Open Chat'
            ).then(choice => {
                if (choice === 'Open Chat') {
                    this.openChat();
                }
            });
        }
    }

    private handleCodeExecution(message: any) {
        const timestamp = new Date().toLocaleTimeString();
        const user = this.session?.users.get(message.userId);
        const username = user?.username || 'Unknown User';

        if (message.result.success) {
            this.outputChannel.appendLine(`\n[${timestamp}] ✅ Code executed by ${username}:`);
            if (message.result.output) {
                this.outputChannel.appendLine(message.result.output);
            }
        } else {
            this.outputChannel.appendLine(`\n[${timestamp}] ❌ Code execution failed (${username}):`);
            this.outputChannel.appendLine(message.result.error);
        }

        this.outputChannel.show();
    }

    private handleServerShared(message: any) {
        this.session!.sharedServers.set(message.port, message.name);
        
        vscode.window.showInformationMessage(
            `🌐 ${message.username} shared server: ${message.name} (${message.url})`,
            'Open in Browser', 'Copy URL'
        ).then(choice => {
            if (choice === 'Open in Browser') {
                vscode.env.openExternal(vscode.Uri.parse(message.url));
            } else if (choice === 'Copy URL') {
                vscode.env.clipboard.writeText(message.url);
            }
        });
    }

    private handleUserPresence(message: any) {
        const user = this.session?.users.get(message.userId);
        if (user) {
            // Update user presence status
            this.updatePresencePanel();
        }
    }

    private handleSessionError(message: any) {
        vscode.window.showErrorMessage(`Session Error: ${message.error}`);
        this.logActivity(`Session error: ${message.error}`, 'error');
    }

    private handleFollowUser(message: any) {
        if (message.targetUserId === this.userId && message.uri) {
            // Someone is following us to a file
            this.followUserToFile(message.uri);
        }
    }

    private updateCursorDecorations(uri: string) {
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === uri
        );

        if (!editor || !this.session) return;

        // Clear existing decorations
        const existingDecorations = this.documentDecorations.get(uri) || [];
        existingDecorations.forEach(decoration => decoration.dispose());

        const newDecorations: vscode.TextEditorDecorationType[] = [];

        // Create cursor decorations for each user
        this.session.users.forEach(user => {
            if (user.id === this.userId || !user.cursor) return;

            const cursorDecoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: user.color + '40', // Semi-transparent
                border: `2px solid ${user.color}`,
                borderRadius: '2px',
                after: {
                    contentText: ` ${user.username}`,
                    backgroundColor: user.color,
                    color: 'white',
                    fontWeight: 'bold',
                    margin: '0 0 0 5px'
                }
            });

            const range = user.selection || new vscode.Range(user.cursor, user.cursor);
            editor.setDecorations(cursorDecoration, [range]);
            newDecorations.push(cursorDecoration);
        });

        this.documentDecorations.set(uri, newDecorations);
    }

    private handleLocalDocumentChange(event: vscode.TextDocumentChangeEvent) {
        if (!this.session?.sharedFiles.has(event.document.uri.toString())) {
            return; // Only sync shared files
        }

        event.contentChanges.forEach(change => {
            const operation: DocumentOperation = {
                type: change.text ? (change.rangeLength > 0 ? 'replace' : 'insert') : 'delete',
                range: change.range,
                text: change.text,
                timestamp: Date.now(),
                userId: this.userId,
                operationId: uuidv4()
            };

            this.sendMessage({
                type: 'documentOperation',
                sessionId: this.session!.id,
                userId: this.userId,
                uri: event.document.uri.toString(),
                operation: operation
            });
        });
    }

    private handleCursorChange(event: vscode.TextEditorSelectionChangeEvent) {
        const selection = event.selections[0];
        
        this.sendMessage({
            type: 'cursorUpdate',
            sessionId: this.session!.id,
            userId: this.userId,
            uri: event.textEditor.document.uri.toString(),
            cursor: selection.active,
            selection: selection.isEmpty ? null : selection
        });
    }

    async shareCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.session) {
            vscode.window.showWarningMessage('No active file to share');
            return;
        }

        const uri = editor.document.uri.toString();
        
        // Check if already shared
        if (this.session.sharedFiles.has(uri)) {
            vscode.window.showInformationMessage('This file is already shared');
            return;
        }

        this.session.sharedFiles.add(uri);

        this.sendMessage({
            type: 'shareFile',
            sessionId: this.session.id,
            userId: this.userId,
            uri: uri,
            filename: editor.document.fileName,
            content: editor.document.getText(),
            language: editor.document.languageId
        });

        vscode.window.showInformationMessage(`Shared file: ${editor.document.fileName}`);
        this.logActivity(`Shared file: ${editor.document.fileName}`);
    }

    async unshareCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.session) {
            vscode.window.showWarningMessage('No active file to unshare');
            return;
        }

        const uri = editor.document.uri.toString();
        
        if (!this.session.sharedFiles.has(uri)) {
            vscode.window.showInformationMessage('This file is not shared');
            return;
        }

        this.session.sharedFiles.delete(uri);

        this.sendMessage({
            type: 'unshareFile',
            sessionId: this.session.id,
            userId: this.userId,
            uri: uri,
            filename: editor.document.fileName
        });

        vscode.window.showInformationMessage(`Unshared file: ${editor.document.fileName}`);
        this.logActivity(`Unshared file: ${editor.document.fileName}`);
    }

    async shareSelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.session) {
            vscode.window.showWarningMessage('No active editor or session');
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showWarningMessage('No text selected');
            return;
        }

        const selectedText = editor.document.getText(selection);
        const language = editor.document.languageId;

        // Send as chat message with code type
        this.sendMessage({
            type: 'chatMessage',
            sessionId: this.session.id,
            userId: this.userId,
            username: this.username,
            message: `Shared code snippet from ${editor.document.fileName}`,
            messageType: 'code',
            timestamp: new Date().toISOString(),
            metadata: {
                code: selectedText,
                language: language,
                filename: editor.document.fileName,
                range: {
                    start: selection.start,
                    end: selection.end
                }
            }
        });

        vscode.window.showInformationMessage('Code selection shared in chat');
    }

    async executeSharedCode() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.session) {
            vscode.window.showWarningMessage('No active editor or session');
            return;
        }

        const selection = editor.selection;
        const code = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
        const language = this.getLanguageFromDocument(editor.document);

        // Show confirmation dialog
        const choice = await vscode.window.showWarningMessage(
            `Execute ${language} code for all session participants?`,
            { modal: true },
            'Execute', 'Cancel'
        );

        if (choice !== 'Execute') return;

        this.sendMessage({
            type: 'executeCode',
            sessionId: this.session.id,
            userId: this.userId,
            code: code,
            language: language,
            filename: editor.document.fileName
        });

        this.outputChannel.appendLine(`\n[${new Date().toLocaleTimeString()}] Executing ${language} code...`);
        this.outputChannel.show();
    }

    async shareLocalServer() {
        const portInput = await vscode.window.showInputBox({
            prompt: 'Enter the port number of your local server',
            placeHolder: 'e.g., 3000',
            validateInput: (value) => {
                const port = parseInt(value);
                if (isNaN(port) || port < 1 || port > 65535) {
                    return 'Please enter a valid port number (1-65535)';
                }
                return null;
            }
        });

        if (!portInput) return;

        const serverName = await vscode.window.showInputBox({
            prompt: 'Enter a name for your server (optional)',
            placeHolder: 'e.g., My API Server'
        }) || `Server on port ${portInput}`;

        const port = parseInt(portInput);
        const url = `http://localhost:${port}`;

        if (this.session) {
            this.session.sharedServers.set(port, serverName);
        }

        this.sendMessage({
            type: 'shareServer',
            sessionId: this.session!.id,
            userId: this.userId,
            port: port,
            name: serverName,
            url: url
        });

        vscode.window.showInformationMessage(`Shared server: ${serverName} (${url})`);
        this.logActivity(`Shared server: ${serverName} on port ${port}`);
    }

    async shareTerminal() {
        if (!this.session) {
            vscode.window.showWarningMessage('No active Live Share session');
            return;
        }

        const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Live Share Terminal');
        const terminalId = uuidv4();
        
        this.session.activeTerminals.add(terminalId);

        this.sendMessage({
            type: 'shareTerminal',
            sessionId: this.session.id,
            userId: this.userId,
            terminalId: terminalId,
            name: terminal.name
        });

        vscode.window.showInformationMessage('Terminal shared with session participants');
        this.logActivity('Shared terminal with session');
    }

    async followUser() {
        if (!this.session || this.session.users.size === 0) {
            vscode.window.showWarningMessage('No users to follow in this session');
            return;
        }

        const users = Array.from(this.session.users.values());
        const userItems = users.map(user => ({
            label: user.username,
            description: user.activeFile ? `Currently in: ${user.activeFile}` : 'No active file',
            userId: user.id
        }));

        const selectedUser = await vscode.window.showQuickPick(userItems, {
            placeHolder: 'Select a user to follow'
        });

        if (selectedUser) {
            this.startFollowingUser(selectedUser.userId);
        }
    }

    private startFollowingUser(userId: string) {
        this.followingUserId = userId;
        const user = this.session?.users.get(userId);
        
        if (user) {
            vscode.window.showInformationMessage(`Following ${user.username}`, 'Stop Following');
            this.logActivity(`Started following ${user.username}`);
            
            // Follow to their current file if available
            if (user.activeFile) {
                this.followUserToFile(user.activeFile);
            }
        }
    }

    async stopFollowing() {
        if (!this.followingUserId) return;
        
        const user = this.session?.users.get(this.followingUserId);
        this.followingUserId = undefined;
        
        if (user) {
            vscode.window.showInformationMessage(`Stopped following ${user.username}`);
            this.logActivity(`Stopped following ${user.username}`);
        }
    }

    async focusOnUser(userId: string) {
        const user = this.session?.users.get(userId);
        if (!user || !user.activeFile) return;

        await this.followUserToFile(user.activeFile);
        
        // Scroll to user's cursor position if available
        if (user.cursor) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const range = new vscode.Range(user.cursor, user.cursor);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        }
    }

    async toggleReadOnlyMode() {
        // This would require custom file system provider implementation
        vscode.window.showInformationMessage('Read-only mode toggle coming in future update');
    }

    async exportSession() {
        if (!this.session) return;

        const exportData = {
            sessionId: this.session.id,
            participants: Array.from(this.session.users.values()).map(u => u.username),
            sharedFiles: Array.from(this.session.sharedFiles),
            chatMessages: this.chatMessages,
            timestamp: new Date().toISOString()
        };

        const content = JSON.stringify(exportData, null, 2);
        
        const doc = await vscode.workspace.openTextDocument({
            content: content,
            language: 'json'
        });
        
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage('Session data exported to new document');
    }

    async showSettings() {
        const settingsPanel = vscode.window.createWebviewPanel(
            'liveshareSettings',
            'Live Share Settings',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        settingsPanel.webview.html = this.getSettingsHtml();
        
        settingsPanel.webview.onDidReceiveMessage(message => {
            switch (message.type) {
                case 'updateSetting':
                    // Handle setting updates
                    this.logActivity(`Setting updated: ${message.setting} = ${message.value}`);
                    break;
            }
        });
    }

    async openChat() {
        if (!this.session) {
            vscode.window.showWarningMessage('No active Live Share session');
            return;
        }

        if (this.chatPanel) {
            this.chatPanel.reveal();
            return;
        }

        this.chatPanel = vscode.window.createWebviewPanel(
            'liveshareChat',
            `💬 Live Share Chat - ${this.session.id}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.chatPanel.webview.html = this.getChatHtml();

        // Load existing messages
        this.chatMessages.forEach(msg => {
            this.chatPanel!.webview.postMessage({
                evt: 'loadMessage',
                ...msg
            });
        });
        

        this.chatPanel.webview.onDidReceiveMessage(message => {
            if (message.type === 'sendMessage' && this.ws && this.session) {
                this.sendMessage({
                    type: 'chatMessage',
                    sessionId: this.session.id,
                    userId: this.userId,
                    username: this.username,
                    message: message.text,
                    messageType: 'text',
                    timestamp: new Date().toISOString()
                });
            }
        });

        this.chatPanel.onDidDispose(() => {
            this.chatPanel = undefined;
        });
    }

    private showPresence() {
        if (!this.session) {
            vscode.window.showWarningMessage('No active Live Share session');
            return;
        }

        if (this.presencePanel) {
            this.presencePanel.reveal();
            return;
        }

        this.presencePanel = vscode.window.createWebviewPanel(
            'livesharePresence',
            `👥 Live Share Participants`,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        this.updatePresencePanel();

        this.presencePanel.webview.onDidReceiveMessage(message => {
            switch (message.type) {
                case 'followUser':
                    this.startFollowingUser(message.userId);
                    break;
                case 'focusUser':
                    this.focusOnUser(message.userId);
                    break;
            }
        });

        this.presencePanel.onDidDispose(() => {
            this.presencePanel = undefined;
        });
    }

    private updatePresencePanel() {
        if (!this.presencePanel || !this.session) return;

        const users = Array.from(this.session.users.values());
        const html = this.getPresenceHtml(users);
        this.presencePanel.webview.html = html;
    }

    async endSession() {
        if (!this.session) return;

        const choice = await vscode.window.showWarningMessage(
            'Are you sure you want to end the Live Share session?',
            { modal: true },
            'End Session', 'Cancel'
        );

        if (choice === 'End Session') {
            if (this.ws) {
                this.sendMessage({
                    type: 'endSession',
                    sessionId: this.session.id,
                    userId: this.userId
                });
                this.ws.close();
            }

            this.cleanup();
            vscode.window.showInformationMessage('Live Share session ended');
            this.logActivity('Live Share session ended by user');
        }
    }

    private cleanup() {
        // Clear reconnection timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }

        this.session = null;
        this.ws = null;
        this.isLocalChange = false;
        this.followingUserId = undefined;
        this.reconnectAttempts = 0;
        this.chatMessages = [];

        // Update context
        this.updateContext();

        // Clear decorations
        this.documentDecorations.forEach(decorations => {
            decorations.forEach(decoration => decoration.dispose());
        });
        this.documentDecorations.clear();

        // Close panels
        if (this.chatPanel) {
            this.chatPanel.dispose();
            this.chatPanel = undefined;
        }

        if (this.presencePanel) {
            this.presencePanel.dispose();
            this.presencePanel = undefined;
        }

        this.updateStatusBar();
    }

    private updateStatusBar() {
        if (!this.session) {
            this.statusBar.text = "$(live-share) Start Live Share";
            this.statusBar.command = 'liveshare.startSession';
            this.statusBar.tooltip = 'Start a Live Share session';
            this.statusBar.backgroundColor = undefined;
        } else {
            const userCount = this.session.users.size + 1; // +1 for current user
            this.statusBar.text = `$(live-share) ${this.session.id} (${userCount})`;
            this.statusBar.command = 'liveshare.showPresence';
            this.statusBar.tooltip = `Live Share session: ${this.session.id}\nParticipants: ${userCount}\nClick to show participants`;
            this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.activeBackground');
        }
    }

    private showSessionStartedMessage() {
        const message = `🎉 Live Share session started successfully!\n\n` +
                       `Session ID: ${this.session!.id}\n` +
                       `Share this ID with others to invite them to collaborate.`;
        
        vscode.window.showInformationMessage(message, 'Copy ID', 'Open Chat')
            .then(choice => {
                if (choice === 'Copy ID') {
                    vscode.env.clipboard.writeText(this.session!.id);
                } else if (choice === 'Open Chat') {
                    this.openChat();
                }
            });
    }

    private shareSessionLink() {
        if (!this.session) return;
        
        const link = `vscode://liveshare/join?session=${this.session.id}`;
        vscode.env.clipboard.writeText(link);
        vscode.window.showInformationMessage('Session link copied to clipboard!');
    }

    // Utility methods
    private sendMessage(message: any) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            this.logActivity('Cannot send message: WebSocket not connected', 'warn');
        }
    }

    private generateSessionId(): string {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    private getUsername(): string {
        const config = vscode.workspace.getConfiguration();
        return config.get('liveshare.username') ||
               config.get('git.userName') || 
               process.env.USER || 
               process.env.USERNAME || 
               'Anonymous';
    }

    private getLanguageFromDocument(document: vscode.TextDocument): string {
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
            case 'php': return 'php';
            case 'rb': return 'ruby';
            case 'cs': return 'csharp';
            case 'swift': return 'swift';
            case 'kt': return 'kotlin';
            case 'scala': return 'scala';
            default: return document.languageId || 'text';
        }
    }

    private getLanguageFromUri(uri: string): string {
        const extension = uri.split('.').pop()?.toLowerCase();
        switch (extension) {
            case 'py': return 'python';
            case 'js': case 'jsx': return 'javascript';
            case 'ts': case 'tsx': return 'typescript';
            case 'java': return 'java';
            case 'cpp': case 'cc': case 'cxx': return 'cpp';
            case 'c': return 'c';
            case 'go': return 'go';
            case 'rs': return 'rust';
            case 'html': return 'html';
            case 'css': return 'css';
            case 'json': return 'json';
            case 'xml': return 'xml';
            case 'md': return 'markdown';
            case 'yaml': case 'yml': return 'yaml';
            default: return 'plaintext';
        }
    }

    private logActivity(message: string, level: 'info' | 'warn' | 'error' = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
        this.outputChannel.appendLine(`[${timestamp}] ${prefix} ${message}`);
        
        // Also log to console for debugging
        console.log(`[LiveShare ${level.toUpperCase()}] ${message}`);
    }

    private getChatHtml(): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { 
                    font-family: var(--vscode-font-family); 
                    padding: 10px; 
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    margin: 0;
                }
                #messages { 
                    height: 400px; 
                    overflow-y: auto; 
                    border: 1px solid var(--vscode-panel-border); 
                    padding: 10px; 
                    margin-bottom: 10px; 
                    background: var(--vscode-input-background);
                    border-radius: 4px;
                }
                #inputContainer {
                    display: flex;
                    gap: 10px;
                }
                #messageInput { 
                    flex: 1;
                    padding: 8px; 
                    border: 1px solid var(--vscode-input-border);
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 4px;
                    font-size: 14px;
                }
                #messageInput:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                }
                #sendButton {
                    padding: 8px 15px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    cursor: pointer;
                    border-radius: 4px;
                    font-size: 14px;
                }
                #sendButton:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .message { 
                    margin-bottom: 10px; 
                    padding: 8px;
                    border-radius: 4px;
                    background: var(--vscode-editor-background);
                    border-left: 3px solid transparent;
                }
                .message.code {
                    border-left-color: var(--vscode-textLink-foreground);
                    background: var(--vscode-textBlockQuote-background);
                }
                .message.code pre {
                    margin: 8px 0;
                    padding: 8px;
                    background: var(--vscode-textCodeBlock-background);
                    border-radius: 4px;
                    overflow-x: auto;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                }
                .username { 
                    font-weight: bold; 
                    color: var(--vscode-textLink-foreground); 
                }
                .timestamp { 
                    font-size: 0.8em; 
                    color: var(--vscode-descriptionForeground); 
                    margin-left: 10px;
                }
                .own-message {
                    background: var(--vscode-textBlockQuote-background);
                    border-left-color: var(--vscode-textLink-foreground);
                }
                .system-message {
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                    text-align: center;
                    border-left: none;
                }
                .typing-indicator {
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    font-size: 0.9em;
                }
                #header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px 0;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    margin-bottom: 10px;
                }
                #title {
                    font-weight: bold;
                    font-size: 16px;
                }
                #status {
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                }
            </style>
        </head>
        <body>
            <div id="header">
                <div id="title">💬 Live Share Chat</div>
                <div id="status">Connected</div>
            </div>
            <div id="messages"></div>
            <div id="inputContainer">
                <input type="text" id="messageInput" placeholder="Type a message..." maxlength="500" />
                <button id="sendButton">Send</button>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                const messages = document.getElementById('messages');
                const input = document.getElementById('messageInput');
                const sendButton = document.getElementById('sendButton');
                
                function sendMessage() {
                    const text = input.value.trim();
                    if (text) {
                        vscode.postMessage({ type: 'sendMessage', text: text });
                        addMessage('You', text, new Date().toISOString(), true, 'text');
                        input.value = '';
                    }
                }
                
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                    }
                });
                
                sendButton.addEventListener('click', sendMessage);
                
                window.addEventListener('message', (event) => {
                    const message = event.data;
                    if (message.type === 'newMessage' || message.type === 'loadMessage') {
                        addMessage(message.username, message.message, message.timestamp, false, message.type, message.metadata);
                    }
                });
                
                function addMessage(username, message, timestamp, isOwn, messageType = 'text', metadata = null) {
                    const div = document.createElement('div');
                    div.className = 'message' + (isOwn ? ' own-message' : '') + (messageType === 'code' ? ' code' : '');
                    const time = new Date(timestamp).toLocaleTimeString();
                    
                    let content = message;
                    if (messageType === 'code' && metadata && metadata.code) {
                        content = message + '<pre><code>' + escapeHtml(metadata.code) + '</code></pre>';
                        if (metadata.filename) {
                            content += '<small>From: ' + metadata.filename + '</small>';
                        }
                    }
                    
                    div.innerHTML = \`<span class="username">\${escapeHtml(username)}:</span> \${content}<span class="timestamp">[\${time}]</span>\`;
                    messages.appendChild(div);
                    messages.scrollTop = messages.scrollHeight;
                }
                
                function escapeHtml(text) {
                    const map = {
                        '&': '&amp;',
                        '<': '&lt;',
                        '>': '&gt;',
                        '"': '&quot;',
                        "'": '&#039;'
                    };
                    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
                }
                
                // Auto-focus input
                input.focus();
            </script>
        </body>
        </html>`;
    }

    private getPresenceHtml(users: User[]): string {
        const userList = users.map(user => `
            <div class="user" style="border-left: 4px solid ${user.color}">
                <div class="user-header">
                    <div class="username">${user.username}</div>
                    <div class="user-actions">
                        <button onclick="followUser('${user.id}')" title="Follow this user">👁️</button>
                        <button onclick="focusUser('${user.id}')" title="Go to user's location">🎯</button>
                    </div>
                </div>
                <div class="status">
                    ${user.activeFile ? `📄 ${user.activeFile.split('/').pop()}` : '💤 No active file'}
                </div>
                ${user.cursor ? `<div class="cursor-info">Line ${user.cursor.line + 1}, Column ${user.cursor.character + 1}</div>` : ''}
            </div>
        `).join('');

        return `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { 
                    font-family: var(--vscode-font-family); 
                    padding: 15px;
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    margin: 0;
                }
                .user {
                    padding: 12px;
                    margin-bottom: 10px;
                    background: var(--vscode-input-background);
                    border-radius: 6px;
                    border: 1px solid var(--vscode-panel-border);
                }
                .user-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                }
                .username {
                    font-weight: bold;
                    font-size: 14px;
                }
                .user-actions {
                    display: flex;
                    gap: 8px;
                }
                .user-actions button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 8px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                }
                .user-actions button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .status {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 4px;
                }
                .cursor-info {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    font-family: var(--vscode-editor-font-family);
                }
                .header {
                    margin-bottom: 20px;
                    font-size: 16px;
                    font-weight: bold;
                    padding-bottom: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .current-user {
                    border-left-color: #007ACC !important;
                    background: var(--vscode-textBlockQuote-background);
                }
                .session-info {
                    background: var(--vscode-textBlockQuote-background);
                    padding: 10px;
                    border-radius: 4px;
                    margin-bottom: 15px;
                    font-size: 12px;
                }
            </style>
        </head>
        <body>
            <div class="header">👥 Session Participants</div>
            
            <div class="session-info">
                <strong>Session ID:</strong> ${this.session!.id}<br>
                <strong>Total Participants:</strong> ${users.length + 1}
            </div>
            
            <div class="user current-user" style="border-left: 4px solid #007ACC">
                <div class="user-header">
                    <div class="username">${this.username} (You)</div>
                    <div class="status">${this.session!.isHost ? '👑 Host' : '👤 Participant'}</div>
                </div>
            </div>
            
            ${userList || '<div style="text-align: center; color: var(--vscode-descriptionForeground); padding: 20px;">No other participants yet</div>'}
            
            <script>
                const vscode = acquireVsCodeApi();
                
                function followUser(userId) {
                    vscode.postMessage({ type: 'followUser', userId: userId });
                }
                
                function focusUser(userId) {
                    vscode.postMessage({ type: 'focusUser', userId: userId });
                }
            </script>
        </body>
        </html>`;
    }

    private getSettingsHtml(): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    background: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .setting-group {
                    margin-bottom: 25px;
                    padding: 15px;
                    background: var(--vscode-input-background);
                    border-radius: 6px;
                    border: 1px solid var(--vscode-panel-border);
                }
                .setting-title {
                    font-weight: bold;
                    font-size: 16px;
                    margin-bottom: 10px;
                    color: var(--vscode-textLink-foreground);
                }
                .setting-item {
                    margin-bottom: 15px;
                }
                .setting-label {
                    display: block;
                    margin-bottom: 5px;
                    font-weight: 500;
                }
                .setting-description {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 8px;
                }
                input[type="text"], input[type="number"], select {
                    width: 100%;
                    max-width: 300px;
                    padding: 8px;
                    border: 1px solid var(--vscode-input-border);
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 4px;
                }
                input[type="checkbox"] {
                    margin-right: 8px;
                }
                .button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-right: 10px;
                    margin-top: 10px;
                }
                .button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .header {
                    font-size: 20px;
                    font-weight: bold;
                    margin-bottom: 20px;
                    padding-bottom: 10px;
                    border-bottom: 2px solid var(--vscode-textLink-foreground);
                }
            </style>
        </head>
        <body>
            <div class="header">⚙️ Live Share Settings</div>
            
            <div class="setting-group">
                <div class="setting-title">User Preferences</div>
                
                <div class="setting-item">
                    <label class="setting-label">Display Name</label>
                    <div class="setting-description">Your name shown to other participants</div>
                    <input type="text" id="username" value="${this.username}" />
                </div>
                
                <div class="setting-item">
                    <label class="setting-label">Auto-follow new users</label>
                    <div class="setting-description">Automatically follow new participants when they join</div>
                    <input type="checkbox" id="autoFollow" />
                </div>
                
                <div class="setting-item">
                    <label class="setting-label">Show cursor animations</label>
                    <div class="setting-description">Display animated cursors for other participants</div>
                    <input type="checkbox" id="cursorAnimations" checked />
                </div>
            </div>
            
            <div class="setting-group">
                <div class="setting-title">Session Settings</div>
                
                <div class="setting-item">
                    <label class="setting-label">Default Server Port</label>
                    <div class="setting-description">Default port for collaboration server</div>
                    <input type="number" id="serverPort" value="8000" min="1024" max="65535" />
                </div>
                
                <div class="setting-item">
                    <label class="setting-label">Auto-share active file</label>
                    <div class="setting-description">Automatically share files when switching between them</div>
                    <input type="checkbox" id="autoShareFiles" />
                </div>
                
                <div class="setting-item">
                    <label class="setting-label">Maximum session duration (hours)</label>
                    <div class="setting-description">Automatically end sessions after this duration (0 = unlimited)</div>
                    <input type="number" id="maxDuration" value="8" min="0" max="24" />
                </div>
            </div>
            
            <div class="setting-group">
                <div class="setting-title">Security & Privacy</div>
                
                <div class="setting-item">
                    <label class="setting-label">Require approval for file sharing</label>
                    <div class="setting-description">Ask permission before sharing files with participants</div>
                    <input type="checkbox" id="requireApproval" />
                </div>
                
                <div class="setting-item">
                    <label class="setting-label">Enable read-only mode for guests</label>
                    <div class="setting-description">Prevent non-host participants from editing files</div>
                    <input type="checkbox" id="readOnlyGuests" />
                </div>
                
                <div class="setting-item">
                    <label class="setting-label">Log session activity</label>
                    <div class="setting-description">Keep detailed logs of session activities</div>
                    <input type="checkbox" id="enableLogging" checked />
                </div>
            </div>
            
            <div class="setting-group">
                <div class="setting-title">Advanced</div>
                
                <div class="setting-item">
                    <label class="setting-label">Reconnection attempts</label>
                    <div class="setting-description">Number of times to attempt reconnection on disconnect</div>
                    <input type="number" id="reconnectAttempts" value="5" min="0" max="10" />
                </div>
                
                <div class="setting-item">
                    <label class="setting-label">Operation sync delay (ms)</label>
                    <div class="setting-description">Delay between document operations to prevent conflicts</div>
                    <input type="number" id="syncDelay" value="50" min="0" max="1000" step="10" />
                </div>
            </div>
            
            <button class="button" onclick="saveSettings()">Save Settings</button>
            <button class="button" onclick="resetSettings()">Reset to Defaults</button>
            
            <script>
                const vscode = acquireVsCodeApi();
                
                function saveSettings() {
                    const settings = {
                        username: document.getElementById('username').value,
                        autoFollow: document.getElementById('autoFollow').checked,
                        cursorAnimations: document.getElementById('cursorAnimations').checked,
                        serverPort: parseInt(document.getElementById('serverPort').value),
                        autoShareFiles: document.getElementById('autoShareFiles').checked,
                        maxDuration: parseInt(document.getElementById('maxDuration').value),
                        requireApproval: document.getElementById('requireApproval').checked,
                        readOnlyGuests: document.getElementById('readOnlyGuests').checked,
                        enableLogging: document.getElementById('enableLogging').checked,
                        reconnectAttempts: parseInt(document.getElementById('reconnectAttempts').value),
                        syncDelay: parseInt(document.getElementById('syncDelay').value)
                    };
                    
                    vscode.postMessage({ type: 'saveSettings', settings: settings });
                }
                
                function resetSettings() {
                    if (confirm('Reset all settings to defaults?')) {
                        vscode.postMessage({ type: 'resetSettings' });
                        location.reload();
                    }
                }
            </script>
        </body>
        </html>`;
    }

    dispose() {
        this.cleanup();
    }
}

// Extension lifecycle
let liveShareManager: LiveShareManager;

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Enhanced Live Share extension activated!');
    
    // Register configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('liveshare')) {
            // Reload settings
            if (liveShareManager) {
                // Update manager with new settings
            }
        }
    });
    
    context.subscriptions.push(configWatcher);
    
    liveShareManager = new LiveShareManager(context);
    
    // Register URI handler for joining sessions via links
    const uriHandler = vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
            if (uri.path === '/join') {
                const sessionId = uri.query.split('session=')[1];
                if (sessionId && liveShareManager) {
                    // Auto-join session
                    vscode.window.showInformationMessage(
                        `Join Live Share session: ${sessionId}?`,
                        'Join', 'Cancel'
                    ).then(choice => {
                        if (choice === 'Join') {
                            // Simulate joining with the session ID
                            vscode.commands.executeCommand('liveshare.joinSession');
                        }
                    });
                }
            }
        }
    });
    
    context.subscriptions.push(uriHandler);
}

export function deactivate() {
    console.log('🔌 Live Share extension deactivated');
    if (liveShareManager) {
        liveShareManager.dispose();
    }
}