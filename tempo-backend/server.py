import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Allow frontend to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.websocket("/ws")
async def midi_stream_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🟢 Client connected to MIDI stream")
    
    # Dictionary to remember when a note was pressed down
    active_notes = {}

    try:
        while True:
            # Wait for data from the React frontend
            data = await websocket.receive_text()
            event = json.loads(data)
            
            event_type = event.get("type")
            note = event.get("note")
            timestamp = event.get("time") # Time in milliseconds from the browser

            if event_type == "note_on":
                # Store the exact start time
                active_notes[note] = timestamp
                print(f"🎵 Note ON: {note}")

            elif event_type == "note_off":
                if note in active_notes:
                    # Calculate duration
                    start_time = active_notes.pop(note)
                    duration_ms = timestamp - start_time
                    duration_sec = round(duration_ms / 1000, 3)
                    
                    # Send the processed data back to React
                    response = {
                        "action": "processed_note",
                        "note": note,
                        "duration_seconds": duration_sec
                    }
                    print(f"✅ Processed: {note} played for {duration_sec}s")
                    await websocket.send_text(json.dumps(response))

    except WebSocketDisconnect:
        print("🔴 Client disconnected")