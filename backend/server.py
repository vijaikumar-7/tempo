import json
import os
import asyncio
from pathlib import Path
import tempfile
import librosa
import numpy as np
import soundfile as sf
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional

# Load .env from project root (one level up from /backend)
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
        print(f"📋 Loaded .env from {env_path}")
except ImportError:
    pass

app = FastAPI(title="Tempo Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ══════════════════════════════════════════════════════
# OPENAI COACHING
# ══════════════════════════════════════════════════════

SYSTEM_PROMPT = """You are Tempo Coach — an expert piano teacher and AI music tutor. You are warm, encouraging, technically precise, and conversational.

Your personality:
- Celebrate small wins genuinely ("Nice! That B-flat was right in the pocket.")
- Give specific, actionable feedback, not vague encouragement
- Reference exact notes and timing when discussing performance
- Weave in music theory naturally ("You just played a ii-V-I — that's the backbone of jazz!")
- When the learner is frustrated, acknowledge difficulty and offer to simplify
- Playful but never condescending

When you receive performance data, respond with:
1. One specific observation about what went well
2. One specific area to improve (with a concrete tip)
3. A suggestion for what to try next

Keep responses under 3 sentences unless asked for detail. Be concise — they're mid-practice."""


async def get_coach_response(user_message: str) -> str:
    """Call OpenAI and return the full response."""
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        return "Coach is offline. Add OPENAI_API_KEY to your environment to enable AI coaching."

    try:
        import httpx
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "max_tokens": 300,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_message},
                    ],
                },
                timeout=30.0,
            )
            data = response.json()
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"Coach error: {str(e)}"


async def stream_coach_response(websocket: WebSocket, user_message: str):
    """Stream OpenAI response token by token over WebSocket."""
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        await websocket.send_text(json.dumps({
            "action": "coach_response",
            "text": "Coach is offline. Add OPENAI_API_KEY to your .env file.",
            "done": True,
        }))
        return

    try:
        import httpx
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "gpt-4o-mini",
                    "max_tokens": 300,
                    "stream": True,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_message},
                    ],
                },
                timeout=30.0,
            ) as response:
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            text = chunk["choices"][0]["delta"].get("content", "")
                            if text:
                                await websocket.send_text(json.dumps({
                                    "action": "coach_chunk",
                                    "text": text,
                                }))
                        except (json.JSONDecodeError, KeyError, IndexError):
                            pass

        await websocket.send_text(json.dumps({
            "action": "coach_done",
        }))
    except Exception as e:
        await websocket.send_text(json.dumps({
            "action": "coach_response",
            "text": f"Coach error: {str(e)}",
            "done": True,
        }))


# ══════════════════════════════════════════════════════
# MAIN WEBSOCKET (MIDI + Coaching)
# ══════════════════════════════════════════════════════

@app.websocket("/ws")
async def midi_stream_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🟢 Client connected")

    active_notes = {}

    try:
        while True:
            data = await websocket.receive_text()
            event = json.loads(data)
            event_type = event.get("type")

            # ── MIDI note events ────────────────────
            if event_type == "note_on":
                note = event.get("note")
                timestamp = event.get("time")
                active_notes[note] = timestamp
                print(f"🎵 Note ON: {note}")

            elif event_type == "note_off":
                note = event.get("note")
                timestamp = event.get("time")
                if note in active_notes:
                    start_time = active_notes.pop(note)
                    duration_ms = timestamp - start_time
                    duration_sec = round(duration_ms / 1000, 3)
                    await websocket.send_text(json.dumps({
                        "action": "processed_note",
                        "note": note,
                        "duration_seconds": duration_sec,
                    }))

            # ── Coach request ───────────────────────
            elif event_type == "coach_request":
                message = event.get("message", "")
                performance = event.get("performance", {})

                if not message and performance:
                    message = (
                        f"Performance data: {json.dumps(performance)}\n"
                        f"Song: {event.get('song', 'Unknown')}\n"
                        f"Mode: {event.get('mode', 'guided')}\n"
                        "Give me brief coaching feedback."
                    )

                # Stream the response
                await stream_coach_response(websocket, message)

            # ── Save session to InsForge ─────────────
            elif event_type == "save_session":
                session_data = event.get("data", {})
                await websocket.send_text(json.dumps({
                    "action": "session_saved",
                    "success": True,
                    "data": session_data,
                }))

    except WebSocketDisconnect:
        print("🔴 Client disconnected")


# ══════════════════════════════════════════════════════
# TINYFISH SONG CRAWLING (HTTP endpoint)
# ══════════════════════════════════════════════════════

class CrawlRequest(BaseModel):
    url: str
    goal: Optional[str] = None

@app.post("/api/crawl")
async def crawl_songs(req: CrawlRequest):
    """Use TinyFish to crawl a MIDI site for songs."""
    api_key = os.getenv("TINYFISH_API_KEY", "")
    if not api_key:
        raise HTTPException(400, "TINYFISH_API_KEY not set. Get one free at tinyfish.ai")

    goal = req.goal or (
        "Find all available MIDI files. For each, return JSON array: "
        '[{"title":"...","artist":"...","midi_url":"..."}]'
    )

    try:
        import httpx
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://agent.tinyfish.ai/v1/automation/run-sse",
                headers={
                    "X-API-Key": api_key,
                    "Content-Type": "application/json",
                },
                json={"url": req.url, "goal": goal},
            )

            # Parse SSE to get final result
            result = ""
            for line in response.text.split("\n"):
                if line.startswith("data: "):
                    data = line[6:]
                    try:
                        parsed = json.loads(data)
                        if parsed.get("type") == "COMPLETE":
                            result = parsed.get("resultJson", parsed.get("result", ""))
                    except json.JSONDecodeError:
                        pass

            if result:
                return {"songs": json.loads(result), "source": req.url}
            return {"songs": [], "source": req.url, "note": "No results found"}

    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "openai": bool(os.getenv("OPENAI_API_KEY")),
        "tinyfish": bool(os.getenv("TINYFISH_API_KEY")),
    }


# ══════════════════════════════════════════════════════
# LOCAL RHYTHM GENERATION & MIXING
# ══════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════
# LOCAL RHYTHM GENERATION & MIXING
# ══════════════════════════════════════════════════════

@app.post("/api/generate-backing-track")
async def generate_backing_track(user_audio: UploadFile = File(...)):
    """
    Analyzes the user's pure WAV audio for BPM, generates a synchronized
    rhythm track, mixes them together locally, and returns the result.
    """
    # 1. Save the incoming WAV file temporarily
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_in:
        tmp_in.write(await user_audio.read())
        wav_path = tmp_in.name

    try:
        print("🎵 Analyzing pure WAV audio for BPM and beats...")
        # Load the audio (sr=None preserves the original sample rate)
        y, sr = librosa.load(wav_path, sr=None)
        
        # We get both the tempo AND the exact frames where beats occur!
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        
        detected_bpm = round(float(tempo[0]) if isinstance(tempo, (np.ndarray, list)) else float(tempo))
        print(f"⏱️ Detected Tempo: {detected_bpm} BPM")
        print(f"🥁 Found {len(beat_frames)} strong beats in the audio!")

        # FALLBACK: If the recording was too short/ambient to find strict beats, force a metronome!
        if len(beat_frames) == 0:
            print("⚠️ No strong rhythmic beats detected. Forcing a steady metronome...")
            safe_bpm = detected_bpm if detected_bpm > 0 else 120
            samples_per_beat = int(sr * 60 / safe_bpm)
            # Create an array of sample indices for every beat
            beat_samples = np.arange(0, len(y), samples_per_beat)
            # Convert sample indices back to frame indices for librosa.clicks
            beat_frames = librosa.samples_to_frames(beat_samples)

        print("🥁 Synthesizing high-pitched rhythm track...")
        # 3. Generate a click track. 
        # Changed to 1000Hz (high beep) so it is impossible to miss against the piano!
        rhythm_track = librosa.clicks(frames=beat_frames, sr=sr, length=len(y), click_freq=1000.0, click_duration=0.1)

        print("🎛️ Mixing audio tracks...")
        # 4. Mix: Piano at 50% volume, loud click at 100% volume
        mixed_audio = (y * 0.5) + (rhythm_track * 1.0)

        # 5. Save the newly mixed audio
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_out:
            output_wav_path = tmp_out.name

        # Write out using soundfile
        sf.write(output_wav_path, mixed_audio, sr)

        print("✅ Local backing track mixed successfully!")

        # 6. Return the newly mixed track back to the React app!
        return FileResponse(output_wav_path, media_type="audio/wav", filename="mixed_drums.wav")

    except Exception as e:
        print(f"❌ Error processing audio: {e}")
        raise HTTPException(500, f"Audio generation failed: {str(e)}")
    finally:
        # Clean up the original input file
        if os.path.exists(wav_path):
            os.remove(wav_path)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)