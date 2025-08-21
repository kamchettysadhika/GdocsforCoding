#!/usr/bin/env python3
import asyncio
import websockets
import json
import subprocess
import tempfile
import os
import sys
from collections import defaultdict
import uuid
from datetime import datetime

# Store rooms and connections
rooms = defaultdict(dict)
connections = defaultdict(set)
user_cursors = defaultdict(dict)  # room_id -> {user_id: cursor_position}

async def handle_client(websocket, path):
    user_id = str(uuid.uuid4())
    room_id = None
    
    try:
        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get('type')
            
            if msg_type == 'join':
                room_id = data['roomId']
                username = data.get('username', 'Anonymous')
                
                # Add user to room
                connections[room_id].add(websocket)
                if 'users' not in rooms[room_id]:
                    rooms[room_id]['users'] = {}
                rooms[room_id]['users'][user_id] = {
                    'username': username,
                    'websocket': websocket,
                    'joined_at': datetime.now().isoformat()
                }
                
                # Send current content to new user
                if 'content' in rooms[room_id]:
                    await websocket.send(json.dumps({
                        'type': 'documentUpdate',
                        'content': rooms[room_id]['content'],
                        'filename': rooms[room_id].get('filename', 'untitled')
                    }))
                
                # Notify others about new user
                await broadcast_to_room(room_id, {
                    'type': 'userJoined',
                    'userId': user_id,
                    'username': username,
                    'userCount': len(rooms[room_id]['users'])
                }, exclude=websocket)
                
                print(f"✅ User {username} joined room {room_id}")
            
            elif msg_type == 'documentChange':
                room_id = data['roomId']
                content = data['content']
                filename = data.get('filename', 'untitled')
                
                # Update room content
                rooms[room_id]['content'] = content
                rooms[room_id]['filename'] = filename
                
                # Broadcast to other users
                await broadcast_to_room(room_id, {
                    'type': 'documentUpdate',
                    'content': content,
                    'filename': filename,
                    'userId': user_id
                }, exclude=websocket)
            
            elif msg_type == 'cursorPosition':
                room_id = data['roomId']
                position = data['position']
                
                # Update cursor position
                user_cursors[room_id][user_id] = position
                
                # Broadcast cursor position
                await broadcast_to_room(room_id, {
                    'type': 'cursorUpdate',
                    'userId': user_id,
                    'position': position
                }, exclude=websocket)
            
            elif msg_type == 'executeCode':
                room_id = data['roomId']
                code = data['code']
                language = data.get('language', 'python')
                
                # Execute code and broadcast result
                result = await execute_code_safely(code, language)
                await broadcast_to_room(room_id, {
                    'type': 'executionResult',
                    'result': result,
                    'userId': user_id
                })
                
                print(f"🔥 Code executed in room {room_id}")
            
            elif msg_type == 'chatMessage':
                room_id = data['roomId']
                message_text = data['message']
                username = data.get('username', 'Anonymous')
                
                # Broadcast chat message
                await broadcast_to_room(room_id, {
                    'type': 'chatMessage',
                    'message': message_text,
                    'username': username,
                    'userId': user_id,
                    'timestamp': datetime.now().isoformat()
                })
    
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        # Clean up when user disconnects
        if room_id and user_id in rooms.get(room_id, {}).get('users', {}):
            del rooms[room_id]['users'][user_id]
            connections[room_id].discard(websocket)
            
            if user_id in user_cursors.get(room_id, {}):
                del user_cursors[room_id][user_id]
            
            # Notify others about user leaving
            await broadcast_to_room(room_id, {
                'type': 'userLeft',
                'userId': user_id,
                'userCount': len(rooms[room_id]['users'])
            })
            
            print(f"❌ User left room {room_id}")

async def broadcast_to_room(room_id, message, exclude=None):
    """Broadcast message to all users in a room except excluded websocket"""
    if room_id not in connections:
        return
    
    message_str = json.dumps(message)
    disconnected = set()
    
    for websocket in connections[room_id]:
        if websocket == exclude:
            continue
        try:
            await websocket.send(message_str)
        except websockets.exceptions.ConnectionClosed:
            disconnected.add(websocket)
    
    # Clean up disconnected websockets
    connections[room_id] -= disconnected

async def execute_code_safely(code, language='python'):
    """Execute code in a safe sandbox and return result"""
    try:
        if language == 'python':
            # Create temporary file
            with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
                f.write(code)
                temp_file = f.name
            
            # Execute with timeout
            process = await asyncio.create_subprocess_exec(
                sys.executable, temp_file,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                timeout=10  # 10 second timeout
            )
            
            stdout, stderr = await process.communicate()
            
            # Clean up
            os.unlink(temp_file)
            
            if process.returncode == 0:
                return {
                    'success': True,
                    'output': stdout.decode('utf-8'),
                    'language': language
                }
            else:
                return {
                    'success': False,
                    'error': stderr.decode('utf-8'),
                    'language': language
                }
        
        elif language == 'javascript':
            # Execute JavaScript with Node.js
            process = await asyncio.create_subprocess_exec(
                'node', '-e', code,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                timeout=10
            )
            
            stdout, stderr = await process.communicate()
            
            if process.returncode == 0:
                return {
                    'success': True,
                    'output': stdout.decode('utf-8'),
                    'language': language
                }
            else:
                return {
                    'success': False,
                    'error': stderr.decode('utf-8'),
                    'language': language
                }
        
        else:
            return {
                'success': False,
                'error': f'Language {language} not supported yet',
                'language': language
            }
            
    except asyncio.TimeoutError:
        return {
            'success': False,
            'error': 'Code execution timed out (10s limit)',
            'language': language
        }
    except Exception as e:
        return {
            'success': False,
            'error': f'Execution error: {str(e)}',
            'language': language
        }

# Start the server
start_server = websockets.serve(handle_client, "localhost", 8000)
print("🚀 Enhanced collaboration server running on ws://localhost:8000")
print("✨ Features: Real-time sync, Code execution, Chat, Cursors")

asyncio.get_event_loop().run_until_complete(start_server)
asyncio.get_event_loop().run_forever()