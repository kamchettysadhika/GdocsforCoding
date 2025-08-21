#!/usr/bin/env python3
"""
Simplified Live Share Collaboration Server
Focuses on document synchronization, user presence, and chat
Perfect for resume/hackathon projects - shows core collaboration features
"""
import asyncio
import websockets
import json
import signal
from collections import defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from typing import Dict, Set, List, Optional
import uuid
import logging
import traceback
from websockets.exceptions import ConnectionClosedOK, ConnectionClosedError
from websockets.protocol import State


# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

@dataclass
class User:
    id: str
    username: str
    websocket: any
    joined_at: datetime
    last_seen: datetime
    cursor_position: Optional[dict] = None
    active_file: Optional[str] = None
    color: str = "#007ACC"  # User color for presence

@dataclass
class Document:
    uri: str
    filename: str
    content: str
    version: int
    last_modified: datetime
    last_modified_by: str

@dataclass
class Session:
    id: str
    host_id: str
    created_at: datetime
    users: Dict[str, User]
    documents: Dict[str, Document]  # uri -> Document
    chat_history: List[dict]
    is_active: bool = True
    last_activity: datetime = None

class LiveShareServer:
    def __init__(self):
        self.sessions: Dict[str, Session] = {}
        self.user_to_session: Dict[str, str] = {}
        self.connections: Dict[str, any] = {}
        self.connection_metadata: Dict[str, dict] = {}
        self.cleanup_task = None
        self.shutdown_event = asyncio.Event()
        self.user_colors = [
            "#007ACC", "#FF6B6B", "#4ECDC4", "#45B7D1", 
            "#96CEB4", "#FFEAA7", "#DDA0DD", "#FFB347"
        ]
        
    async def start_server(self, host='localhost', port=8000):
        """Start the WebSocket server"""
        logger.info(f"Starting Live Share Document Sync Server on {host}:{port}")
        
        # Start cleanup task
        self.cleanup_task = asyncio.create_task(self.cleanup_inactive_sessions())
        
        # Handle shutdown gracefully
        def signal_handler(signum, frame):
            logger.info("Received shutdown signal...")
            self.shutdown_event.set()
        
        for sig in [signal.SIGINT, signal.SIGTERM]:
            signal.signal(sig, signal_handler)
        
        # Server configuration
        server_config = {
            'max_size': 10 * 1024 * 1024,  # 10MB max message size
            'ping_interval': 20,
            'ping_timeout': 10,
        }
        
        try:
            server = await websockets.serve(
                self.handle_client, 
                host, 
                port,
                **server_config
            )
            
            logger.info("Live Share server is running!")
            logger.info("Features: Document sync, presence awareness, chat")
            
            # Wait for shutdown signal
            await self.shutdown_event.wait()
            
            # Graceful shutdown
            logger.info("Initiating graceful shutdown...")
            await self.graceful_shutdown(server)
            
        except Exception as e:
            logger.error(f"Server startup error: {e}")
            raise

    async def handle_client(self, websocket):
        """Handle individual client connections"""
        user_id = str(uuid.uuid4())
        session_id = None
        
        try:
            remote_addr = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
        except:
            remote_addr = 'unknown'
        
        logger.info(f"New connection: {user_id} from {remote_addr}")
        
        try:
            self.connections[user_id] = websocket
            self.connection_metadata[user_id] = {
                'connected_at': datetime.now(),
                'remote_address': remote_addr,
                'last_ping': datetime.now()
            }
            
            # Send connection acknowledgment
            await self.send_to_user(user_id, {
                'type': 'connectionEstablished',
                'userId': user_id,
                'serverTime': datetime.now().isoformat()
            })
            
            async for message in websocket:
                try:
                    if user_id in self.connection_metadata:
                        self.connection_metadata[user_id]['last_ping'] = datetime.now()
                    
                    if isinstance(message, bytes):
                        message = message.decode('utf-8')
                    
                    data = json.loads(message)
                    
                    # Handle ping messages
                    if data.get('type') == 'ping':
                        await self.send_to_user(user_id, {
                            'type': 'pong',
                            'timestamp': datetime.now().isoformat()
                        })
                        continue
                    
                    await self.process_message(user_id, data)
                    
                    if data.get('sessionId') and session_id != data.get('sessionId'):
                        session_id = data.get('sessionId')
                        self.user_to_session[user_id] = session_id
                        
                except json.JSONDecodeError as e:
                    logger.error(f"Invalid JSON from user {user_id}: {e}")
                    await self.send_error(user_id, "Invalid JSON format")
                except Exception as e:
                    logger.error(f"Error processing message from {user_id}: {e}")
                    await self.send_error(user_id, f"Message processing error: {str(e)}")
                    
        except websockets.exceptions.ConnectionClosedError as e:
            logger.info(f"User {user_id} connection closed: {e.code}")
        except websockets.exceptions.ConnectionClosedOK:
            logger.info(f"User {user_id} disconnected normally")
        except Exception as e:
            logger.error(f"Connection error for user {user_id}: {e}")
        finally:
            await self.cleanup_user(user_id)

    async def process_message(self, user_id: str, data: dict):
        """Process incoming messages"""
        message_type = data.get('type')
        if not message_type:
            return
        
        try:
            handlers = {
                'createSession': self.handle_create_session,
                'joinSession': self.handle_join_session,
                'rejoinSession': self.handle_rejoin_session,
                'documentChange': self.handle_document_change,
                'documentOperation': self.handle_document_operation,
                'cursorUpdate': self.handle_cursor_update,
                'shareDocument': self.handle_share_document,
                'shareFile': self.handle_share_document,
                'unshareFile': self.handle_unshare_file,
                'chatMessage': self.handle_chat_message,
                'activeFileChange': self.handle_active_file_change,
                'endSession': self.handle_end_session,
                'requestDocument': self.handle_request_document,
                'requestFileContent': self.handle_request_document,
                'keepAlive': self.handle_keep_alive,
                'userPresence': self.handle_user_presence,
                'fileClose': self.handle_file_close,
            }
            
            handler = handlers.get(message_type)
            if handler:
                await handler(user_id, data)
            else:
                logger.warning(f"Unknown message type: {message_type}")
                await self.send_error(user_id, f"Unknown message type: {message_type}")
                
        except Exception as e:
            logger.error(f"Error handling {message_type} from {user_id}: {e}")
            await self.send_error(user_id, f"Error processing {message_type}: {str(e)}")

    async def handle_create_session(self, user_id: str, data: dict):
        """Create a new Live Share session"""
        session_id = data.get('sessionId')
        username = data.get('username', 'Anonymous')
        
        if not session_id:
            await self.send_error(user_id, "Session ID is required")
            return
        
        if session_id in self.sessions:
            await self.send_error(user_id, "Session already exists")
            return
        
        # Assign user color
        user_color = self.user_colors[len(self.sessions) % len(self.user_colors)]
        
        user = User(
            id=user_id,
            username=username,
            websocket=self.connections[user_id],
            joined_at=datetime.now(),
            last_seen=datetime.now(),
            color=user_color
        )
        
        session = Session(
            id=session_id,
            host_id=user_id,
            created_at=datetime.now(),
            users={user_id: user},
            documents={},
            chat_history=[],
            last_activity=datetime.now()
        )
        
        self.sessions[session_id] = session
        self.user_to_session[user_id] = session_id
        
        await self.send_to_user(user_id, {
            'type': 'sessionCreated',
            'sessionId': session_id,
            'userId': user_id,
            'userColor': user_color,
            'isHost': True,
            'timestamp': datetime.now().isoformat()
        })
        
        logger.info(f"Session {session_id} created by {username}")

    async def handle_join_session(self, user_id: str, data: dict):
        """Handle user joining an existing session"""
        session_id = data.get('sessionId')
        username = data.get('username', 'Anonymous')
        
        if not session_id:
            await self.send_error(user_id, "Session ID is required")
            return
        
        if session_id not in self.sessions:
            await self.send_error(user_id, "Session not found")
            return
        
        session = self.sessions[session_id]
        
        # Assign user color
        used_colors = [user.color for user in session.users.values()]
        user_color = next((color for color in self.user_colors if color not in used_colors), 
                         self.user_colors[0])
        
        user = User(
            id=user_id,
            username=username,
            websocket=self.connections[user_id],
            joined_at=datetime.now(),
            last_seen=datetime.now(),
            color=user_color
        )
        
        session.users[user_id] = user
        session.last_activity = datetime.now()
        self.user_to_session[user_id] = session_id
        
        # Send session state to new user
        await self.send_to_user(user_id, {
            'type': 'sessionJoined',
            'sessionId': session_id,
            'hostId': session.host_id,
            'userId': user_id,
            'userColor': user_color,
            'users': [
                {
                    'id': u.id,
                    'username': u.username,
                    'color': u.color,
                    'activeFile': u.active_file,
                    'joinedAt': u.joined_at.isoformat()
                }
                for u in session.users.values()
            ],
            'documents': [
                {
                    'uri': doc.uri,
                    'filename': doc.filename,
                    'version': doc.version,
                    'lastModified': doc.last_modified.isoformat()
                }
                for doc in session.documents.values()
            ],
            'sharedFiles': list(session.documents.keys()),
            'chatHistory': session.chat_history[-50:],
            'timestamp': datetime.now().isoformat()
        })
        
        # Notify other users
        await self.broadcast_to_session(session_id, {
            'type': 'userJoined',
            'userId': user_id,
            'username': username,
            'color': user_color,
            'userCount': len(session.users),
            'timestamp': datetime.now().isoformat()
        }, exclude=user_id)
        
        logger.info(f"{username} joined session {session_id}")

    async def handle_rejoin_session(self, user_id: str, data: dict):
        """Handle user rejoining a session"""
        session_id = data.get('sessionId')
        username = data.get('username', 'Anonymous')

        if not session_id or session_id not in self.sessions:
            await self.send_error(user_id, "Session not found for rejoin")
            return
        
        session = self.sessions[session_id]

        # If the user existed before, update their websocket & timestamps
        user = session.users.get(user_id)
        if user:
            user.websocket = self.connections.get(user_id)
            user.last_seen = datetime.now()
        else:
            # Treat as a fresh join on rejoin (harmless & resilient)
            color_in_use = {u.color for u in session.users.values()}
            user_color = next((c for c in self.user_colors if c not in color_in_use),
                             self.user_colors[0])
            user = User(
                id=user_id,
                username=username,
                websocket=self.connections.get(user_id),
                joined_at=datetime.now(),
                last_seen=datetime.now(),
                color=user_color
            )
            session.users[user_id] = user

        self.user_to_session[user_id] = session_id
        session.last_activity = datetime.now()

        # Send current session snapshot back
        await self.send_to_user(user_id, {
            'type': 'sessionJoined',
            'sessionId': session_id,
            'hostId': session.host_id,
            'userId': user_id,
            'userColor': user.color,
            'users': [
                {
                    'id': u.id,
                    'username': u.username,
                    'color': u.color,
                    'activeFile': u.active_file,
                    'joinedAt': u.joined_at.isoformat()
                } for u in session.users.values()
            ],
            'documents': [
                {
                    'uri': d.uri,
                    'filename': d.filename,
                    'version': d.version,
                    'lastModified': d.last_modified.isoformat()
                } for d in session.documents.values()
            ],
            'sharedFiles': list(session.documents.keys()),
            'chatHistory': session.chat_history[-50:],
            'timestamp': datetime.now().isoformat()
        })

        # Let others know they're back
        await self.broadcast_to_session(session_id, {
            'type': 'userJoined',
            'userId': user_id,
            'username': user.username,
            'color': user.color,
            'userCount': len(session.users),
            'timestamp': datetime.now().isoformat()
        }, exclude=user_id)

    async def handle_unshare_file(self, user_id: str, data: dict):
        """Handle file unsharing"""
        session_id = data.get('sessionId')
        uri = data.get('uri')
        filename = data.get('filename', 'untitled')

        if not session_id or session_id not in self.sessions or not uri:
            await self.send_error(user_id, "Invalid unshare request")
            return

        session = self.sessions[session_id]
        if uri in session.documents:
            del session.documents[uri]

        session.last_activity = datetime.now()

        await self.broadcast_to_session(session_id, {
            'type': 'fileUnshared',
            'userId': user_id,
            'uri': uri,
            'filename': filename,
            'timestamp': datetime.now().isoformat()
        })

    async def handle_document_change(self, user_id: str, data: dict):
        """Handle document content changes"""
        session_id = data.get('sessionId')
        
        if not session_id or session_id not in self.sessions:
            await self.send_error(user_id, "Invalid session")
            return
        
        session = self.sessions[session_id]
        uri = data.get('uri')
        changes = data.get('changes', [])
        version = data.get('version', 1)
        
        if not uri:
            await self.send_error(user_id, "Document URI is required")
            return
        
        # Update document if it exists
        if uri in session.documents:
            doc = session.documents[uri]
            doc.version = version
            doc.last_modified = datetime.now()
            doc.last_modified_by = user_id
        
        session.last_activity = datetime.now()
        
        # Broadcast changes to other users
        await self.broadcast_to_session(session_id, {
            'type': 'documentChange',
            'userId': user_id,
            'uri': uri,
            'changes': changes,
            'version': version,
            'timestamp': datetime.now().isoformat()
        }, exclude=user_id)

    async def handle_document_operation(self, user_id: str, data: dict):
        """Handle VS Code document operations"""
        session_id = data.get('sessionId')
        
        if not session_id or session_id not in self.sessions:
            await self.send_error(user_id, "Invalid session")
            return
        
        session = self.sessions[session_id]
        uri = data.get('uri')
        operation = data.get('operation')
        
        if not uri or not operation:
            await self.send_error(user_id, "Document URI and operation are required")
            return
        
        session.last_activity = datetime.now()
        
        # Broadcast operation to other users
        await self.broadcast_to_session(session_id, {
            'type': 'documentOperation',
            'userId': user_id,
            'uri': uri,
            'operation': operation,
            'timestamp': datetime.now().isoformat()
        }, exclude=user_id)

    async def handle_cursor_update(self, user_id: str, data: dict):
        """Handle cursor position updates"""
        session_id = data.get('sessionId')
        
        if not session_id or session_id not in self.sessions:
            return
        
        session = self.sessions[session_id]
        if user_id in session.users:
            session.users[user_id].cursor_position = data.get('cursor')
            session.users[user_id].last_seen = datetime.now()
        
        # Broadcast cursor position
        await self.broadcast_to_session(session_id, {
            'type': 'cursorUpdate',
            'userId': user_id,
            'uri': data.get('uri'),
            'cursor': data.get('cursor'),
            'selection': data.get('selection'),
            'timestamp': datetime.now().isoformat()
        }, exclude=user_id)

    async def handle_share_document(self, user_id: str, data: dict):
        """Handle document sharing"""
        session_id = data.get('sessionId')
        
        if not session_id or session_id not in self.sessions:
            await self.send_error(user_id, "Invalid session")
            return
        
        session = self.sessions[session_id]
        uri = data.get('uri')
        filename = data.get('filename', 'untitled')
        content = data.get('content', '')
        
        # Content size limit (1MB)
        if len(content) > 1024 * 1024:
            await self.send_error(user_id, "Document too large (max 1MB)")
            return
        
        # Create or update document
        document = Document(
            uri=uri,
            filename=filename,
            content=content,
            version=1,
            last_modified=datetime.now(),
            last_modified_by=user_id
        )
        
        session.documents[uri] = document
        session.last_activity = datetime.now()
        
        # Get username for the message
        username = session.users[user_id].username if user_id in session.users else 'Unknown'
        
        # Notify all users with VS Code compatible format
        await self.broadcast_to_session(session_id, {
            'type': 'fileShared',
            'userId': user_id,
            'username': username,
            'uri': uri,
            'filename': filename,
            'content': content,
            'version': 1,
            'timestamp': datetime.now().isoformat()
        })
        
        logger.info(f"Document shared in session {session_id}: {filename}")

    async def handle_request_document(self, user_id: str, data: dict):
        """Handle document content requests"""
        session_id = data.get('sessionId')
        uri = data.get('uri')
        
        if not session_id or session_id not in self.sessions:
            await self.send_error(user_id, "Invalid session")
            return
        
        session = self.sessions[session_id]
        
        if uri and uri in session.documents:
            doc = session.documents[uri]
            await self.send_to_user(user_id, {
                'type': 'fileContent',
                'uri': uri,
                'filename': doc.filename,
                'content': doc.content,
                'version': doc.version,
                'lastModified': doc.last_modified.isoformat()
            })
        else:
            await self.send_error(user_id, "Document not found")

    async def handle_chat_message(self, user_id: str, data: dict):
        """Handle chat messages"""
        session_id = data.get('sessionId')
        message_text = data.get('message', '').strip()
        
        if not session_id or session_id not in self.sessions:
            await self.send_error(user_id, "Invalid session")
            return
        
        if not message_text or len(message_text) > 500:
            await self.send_error(user_id, "Invalid message length")
            return
        
        session = self.sessions[session_id]
        username = session.users[user_id].username if user_id in session.users else 'Unknown'
        user_color = session.users[user_id].color if user_id in session.users else '#007ACC'
        
        chat_message = {
            'type': 'chatMessage',
            'userId': user_id,
            'username': username,
            'userColor': user_color,
            'message': message_text,
            'timestamp': datetime.now().isoformat()
        }
        
        # Store in chat history
        session.chat_history.append(chat_message)
        session.last_activity = datetime.now()
        
        # Keep only last 100 messages
        if len(session.chat_history) > 100:
            session.chat_history = session.chat_history[-100:]
        
        # Broadcast to all users
        await self.broadcast_to_session(session_id, chat_message)

    async def handle_active_file_change(self, user_id: str, data: dict):
        """Handle active file changes for presence awareness"""
        session_id = data.get('sessionId')
        
        if not session_id or session_id not in self.sessions:
            return
        
        session = self.sessions[session_id]
        if user_id in session.users:
            session.users[user_id].active_file = data.get('uri')
            session.users[user_id].last_seen = datetime.now()
        
        # Broadcast presence update
        await self.broadcast_to_session(session_id, {
            'type': 'activeFileChange',
            'userId': user_id,
            'activeFile': data.get('filename'),
            'uri': data.get('uri'),
            'timestamp': datetime.now().isoformat()
        }, exclude=user_id)

    async def handle_user_presence(self, user_id: str, data: dict):
        """Handle user presence updates"""
        session_id = data.get('sessionId')
        
        if not session_id or session_id not in self.sessions:
            return
        
        session = self.sessions[session_id]
        if user_id in session.users:
            session.users[user_id].last_seen = datetime.now()
        
        # Broadcast presence update
        await self.broadcast_to_session(session_id, {
            'type': 'userPresence',
            'userId': user_id,
            'focused': data.get('focused', True),
            'timestamp': datetime.now().isoformat()
        }, exclude=user_id)

    async def handle_file_close(self, user_id: str, data: dict):
        """Handle file close events"""
        session_id = data.get('sessionId')
        
        if not session_id or session_id not in self.sessions:
            return
        
        # Just broadcast the file close event to other users
        await self.broadcast_to_session(session_id, {
            'type': 'fileClose',
            'userId': user_id,
            'uri': data.get('uri'),
            'timestamp': datetime.now().isoformat()
        }, exclude=user_id)

    async def handle_end_session(self, user_id: str, data: dict):
        """Handle session termination"""
        session_id = data.get('sessionId')
        
        if not session_id or session_id not in self.sessions:
            return
        
        session = self.sessions[session_id]
        
        # Only host can end session
        if user_id == session.host_id:
            await self.broadcast_to_session(session_id, {
                'type': 'sessionEnded',
                'reason': 'Host ended session',
                'timestamp': datetime.now().isoformat()
            })
            
            await self.cleanup_session(session_id)
            logger.info(f"Session {session_id} ended by host")

    async def handle_keep_alive(self, user_id: str, data: dict):
        """Handle keep-alive messages"""
        session_id = data.get('sessionId')
        if session_id and session_id in self.sessions:
            session = self.sessions[session_id]
            if user_id in session.users:
                session.users[user_id].last_seen = datetime.now()

    async def send_to_user(self, user_id: str, message: dict):
        """Send message to a specific user"""
        ws = self.connections.get(user_id)
        if not ws:
            return False

        try:
            if getattr(ws, "closed", False):
                await self.cleanup_user(user_id)
                return False

            # Optional state check
            if hasattr(ws, "state"):
                try:
                    if ws.state != State.OPEN:
                        await self.cleanup_user(user_id)
                        return False
                except Exception:
                    # state attribute exists but not comparable; ignore
                    pass

            await ws.send(json.dumps(message))
            return True

        except (ConnectionClosedOK, ConnectionClosedError):
            await self.cleanup_user(user_id)
            return False
        except Exception as e:
            logger.error(f"Error sending to user {user_id}: {e}")
            await self.cleanup_user(user_id)
            return False

    async def send_error(self, user_id: str, error_message: str):
        """Send error message to user"""
        await self.send_to_user(user_id, {
            'type': 'error',
            'message': error_message,
            'timestamp': datetime.now().isoformat()
        })

    async def broadcast_to_session(self, session_id: str, message: dict, exclude: str = None):
        """Broadcast message to all users in a session"""
        if session_id not in self.sessions:
            return
        
        session = self.sessions[session_id]
        disconnected_users = []
        
        for user_id in session.users:
            if user_id == exclude:
                continue
                
            success = await self.send_to_user(user_id, message)
            if not success:
                disconnected_users.append(user_id)
        
        # Clean up disconnected users
        for user_id in disconnected_users:
            await self.cleanup_user(user_id)

    async def cleanup_user(self, user_id: str):
        """Clean up user data when they disconnect"""
        if user_id in self.connections:
            try:
                websocket = self.connections[user_id]
                if not websocket.closed:
                    await websocket.close()
            except:
                pass
            del self.connections[user_id]
        
        if user_id in self.connection_metadata:
            del self.connection_metadata[user_id]
        
        if user_id in self.user_to_session:
            session_id = self.user_to_session[user_id]
            
            if session_id in self.sessions:
                session = self.sessions[session_id]
                
                if user_id in session.users:
                    username = session.users[user_id].username
                    del session.users[user_id]
                    
                    # Notify remaining users
                    await self.broadcast_to_session(session_id, {
                        'type': 'userLeft',
                        'userId': user_id,
                        'username': username,
                        'userCount': len(session.users),
                        'timestamp': datetime.now().isoformat()
                    })
                    
                    # Clean up session if empty or transfer host
                    if not session.users:
                        await self.cleanup_session(session_id)
                    elif user_id == session.host_id:
                        new_host_id = next(iter(session.users.keys()))
                        session.host_id = new_host_id
                        
                        await self.broadcast_to_session(session_id, {
                            'type': 'hostTransferred',
                            'newHostId': new_host_id,
                            'newHostname': session.users[new_host_id].username,
                            'timestamp': datetime.now().isoformat()
                        })
            
            del self.user_to_session[user_id]

    async def cleanup_session(self, session_id: str):
        """Clean up session data"""
        if session_id not in self.sessions:
            return
        
        session = self.sessions[session_id]
        
        # Notify users
        await self.broadcast_to_session(session_id, {
            'type': 'sessionEnded',
            'reason': 'Session cleaned up',
            'timestamp': datetime.now().isoformat()
        })
        
        # Remove user mappings
        users_to_remove = [
            uid for uid, sid in self.user_to_session.items() 
            if sid == session_id
        ]
        
        for user_id in users_to_remove:
            del self.user_to_session[user_id]
        
        del self.sessions[session_id]
        logger.info(f"Session {session_id} cleaned up")

    async def handle_message(self, websocket, msg):
        if msg["type"] == "chat":
        # Broadcast to all except sender
            for ws in self.active_sessions[msg["session_id"]]:
                if ws != websocket:
                    await ws.send(json.dumps(msg))

    async def cleanup_inactive_sessions(self):
        """Periodically clean up inactive sessions"""
        while not self.shutdown_event.is_set():
            try:
                await asyncio.sleep(300)  # Check every 5 minutes
                
                now = datetime.now()
                inactive_sessions = []
                
                for session_id, session in self.sessions.items():
                    if not session.users:
                        inactive_sessions.append(session_id)
                        continue
                    
                    # Check for inactivity (1 hour)
                    if session.last_activity and now - session.last_activity > timedelta(hours=1):
                        inactive_sessions.append(session_id)
                        continue
                    
                    # Check if all users inactive (30 minutes)
                    all_inactive = all(
                        now - user.last_seen > timedelta(minutes=30)
                        for user in session.users.values()
                    )
                    
                    if all_inactive:
                        inactive_sessions.append(session_id)
                
                # Clean up inactive sessions
                for session_id in inactive_sessions:
                    await self.cleanup_session(session_id)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in cleanup task: {e}")

    async def graceful_shutdown(self, server):
        """Gracefully shutdown the server"""
        logger.info("Starting graceful shutdown...")
        
        server.close()
        
        # Notify all users
        for user_id in list(self.connections.keys()):
            await self.send_to_user(user_id, {
                'type': 'serverShutdown',
                'message': 'Server is shutting down',
                'timestamp': datetime.now().isoformat()
            })
        
        # Clean up sessions
        for session_id in list(self.sessions.keys()):
            await self.cleanup_session(session_id)
        
        # Cancel cleanup task
        if self.cleanup_task and not self.cleanup_task.done():
            self.cleanup_task.cancel()
        
        await server.wait_closed()
        logger.info("Graceful shutdown complete")

    def get_stats(self):
        """Get server statistics"""
        return {
            'timestamp': datetime.now().isoformat(),
            'active_sessions': len(self.sessions),
            'total_users': len(self.connections),
            'total_documents': sum(len(s.documents) for s in self.sessions.values()),
            'sessions': {
                sid: {
                    'users': len(session.users),
                    'documents': len(session.documents),
                    'created_at': session.created_at.isoformat(),
                    'last_activity': session.last_activity.isoformat() if session.last_activity else None
                }
                for sid, session in self.sessions.items()
            }
        }

async def main():
    """Main function to start the server"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Live Share Document Sync Server')
    parser.add_argument('--host', default='localhost', help='Host to bind to')
    parser.add_argument('--port', type=int, default=8000, help='Port to bind to')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    
    args = parser.parse_args()
    
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
    
    server = LiveShareServer()
    
    try:
        await server.start_server(args.host, args.port)
    except KeyboardInterrupt:
        logger.info("Server shutting down...")
    except Exception as e:
        logger.error(f"Server error: {e}")

if __name__ == "__main__":
    asyncio.run(main())