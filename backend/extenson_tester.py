#!/usr/bin/env python3
"""
Test script to verify your VS Code extension and WebSocket server work together
Run this alongside your VS Code extension to see the full communication flow
"""
import asyncio
import websockets
import json
import sys
from datetime import datetime

class ExtensionTester:
    def __init__(self):
        self.uri = "ws://localhost:8000"
        self.room_id = "VSCODE"  # Use a predictable room ID
        self.username = "TestBot"
        self.websocket = None

    async def connect_and_monitor(self):
        """Connect to server and monitor all activity"""
        print("🤖 Extension Tester Starting")
        print("="*50)
        print(f"Connecting to: {self.uri}")
        print(f"Room ID: {self.room_id}")
        print(f"Username: {self.username}")
        print("="*50)
        
        try:
            self.websocket = await websockets.connect(self.uri)
            print("✅ Connected to WebSocket server")
            
            # Join the room
            await self.send_message({
                "type": "join",
                "roomId": self.room_id,
                "username": self.username
            })
            
            print("\n🎯 Now start your VS Code extension and:")
            print("1. Start/Join room with ID: VSCODE")
            print("2. Try editing a document")
            print("3. Try executing code")
            print("4. Try sending a chat message")
            print("5. Watch this terminal for real-time updates!")
            print("\n" + "="*50)
            
            # Listen for messages
            await self.listen_for_messages()
            
        except ConnectionRefusedError:
            print("❌ Cannot connect to server!")
            print("Make sure your server.py is running:")
            print("   python3 server.py")
        except Exception as e:
            print(f"❌ Error: {e}")

    async def send_message(self, message):
        """Send message to server"""
        if self.websocket:
            await self.websocket.send(json.dumps(message))
            print(f"📤 SENT: {message['type']}")

    async def listen_for_messages(self):
        """Listen and log all incoming messages"""
        try:
            async for message in self.websocket:
                data = json.loads(message)
                await self.handle_message(data)
        except websockets.exceptions.ConnectionClosed:
            print("🔌 Connection closed")
        except Exception as e:
            print(f"❌ Listen error: {e}")

    async def handle_message(self, data):
        """Handle incoming messages with detailed logging"""
        msg_type = data.get('type')
        timestamp = datetime.now().strftime("%H:%M:%S")
        
        print(f"\n[{timestamp}] 📥 RECEIVED: {msg_type}")
        
        if msg_type == 'userJoined':
            username = data.get('username', 'Unknown')
            user_count = data.get('userCount', 0)
            print(f"   👋 {username} joined! ({user_count} users total)")
            
        elif msg_type == 'documentUpdate':
            filename = data.get('filename', 'untitled')
            content_length = len(data.get('content', ''))
            print(f"   📝 Document updated: {filename} ({content_length} chars)")
            if content_length < 200:  # Show content if it's short
                print(f"   Content preview: {data.get('content', '')[:100]}...")
                
        elif msg_type == 'cursorUpdate':
            user_id = data.get('userId', 'unknown')
            position = data.get('position', {})
            if isinstance(position, dict):
                line = position.get('line', 0)
                char = position.get('character', 0)
                print(f"   👆 User cursor moved to line {line}, char {char}")
            else:
                print(f"   👆 User cursor at position {position}")
                
        elif msg_type == 'executionResult':
            result = data.get('result', {})
            success = result.get('success', False)
            language = result.get('language', 'unknown')
            if success:
                output = result.get('output', '')[:100]
                print(f"   🔥 Code executed successfully ({language})")
                print(f"   Output: {output}...")
            else:
                error = result.get('error', '')[:100]
                print(f"   ❌ Code execution failed ({language})")
                print(f"   Error: {error}...")
                
        elif msg_type == 'chatMessage':
            username = data.get('username', 'Unknown')
            message = data.get('message', '')
            print(f"   💬 {username}: {message}")
            
            # Auto-respond to demonstrate bidirectional communication
            if "hello" in message.lower():
                await asyncio.sleep(1)  # Small delay
                await self.send_message({
                    "type": "chatMessage",
                    "roomId": self.room_id,
                    "message": f"Hello back, {username}! 🤖",
                    "username": self.username
                })
                
        elif msg_type == 'userLeft':
            user_count = data.get('userCount', 0)
            print(f"   👋 User left ({user_count} users remaining)")
            
        else:
            print(f"   📋 Raw data: {json.dumps(data, indent=2)}")

    async def simulate_activity(self):
        """Simulate some activity to test the extension"""
        await asyncio.sleep(5)
        
        print("\n🎭 Simulating some test activity...")
        
        # Send a test document update
        await self.send_message({
            "type": "documentChange",
            "roomId": self.room_id,
            "content": "# Test from Bot\nprint('Hello from test bot!')\n# This should appear in VS Code",
            "filename": "bot_test.py"
        })
        
        await asyncio.sleep(2)
        
        # Send a chat message
        await self.send_message({
            "type": "chatMessage",
            "roomId": self.room_id,
            "message": "Hello from the test bot! VS Code extension working?",
            "username": self.username
        })

async def main():
    tester = ExtensionTester()
    
    # Create tasks for monitoring and simulating
    monitor_task = asyncio.create_task(tester.connect_and_monitor())
    simulate_task = asyncio.create_task(tester.simulate_activity())
    
    try:
        # Wait for either task to complete
        await asyncio.gather(monitor_task, simulate_task)
    except KeyboardInterrupt:
        print("\n👋 Stopping tester...")
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    print("VS Code Extension Tester")
    print("This will help you test your extension integration")
    print("Press Ctrl+C to stop\n")
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 Goodbye!")