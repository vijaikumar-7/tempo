import asyncio
import httpx
import os
import sys
import json
from dotenv import load_dotenv

# 1. Securely load environment variables
load_dotenv()
API_KEY = os.getenv("TINYFISH_API_KEY")

if not API_KEY:
    print("❌ ERROR: TINYFISH_API_KEY not found in .env file.")
    sys.exit(1)

# 2. Define exactly where React needs the file.
# Adjust the ".." and "frontend" parts if your folder structure is different!
REACT_SRC_DIR = os.path.join(os.path.dirname(__file__), "frontend", "public")
OUTPUT_FILE = os.path.join(REACT_SRC_DIR, "songs.json")

urls = [
    "https://www.romwell.com/kids/nursery_rhymes/kids_midi.shtml"
]

goal = """Visit the input URL and find all the downloadable MIDI files for the nursery rhymes. 
Extract the visible song title and the direct absolute URL for the .mid file. 
Return the final result strictly as a JSON array of objects, where each object has a 'title' key and a 'url' key."""

async def process_url(client: httpx.AsyncClient, url: str):
    print(f"🐟 Sending Enterprise TinyFish agent to {url}...")
    
    try:
        async with client.stream(
            "POST",
            "https://agent.tinyfish.ai/v1/automation/run-sse",
            headers={
                "X-API-Key": API_KEY,
                "Content-Type": "application/json",
            },
            json={"url": url, "goal": goal},
            timeout=300.0,
        ) as response:
            
            response.raise_for_status()
            
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:]
                    
                    # Parse each SSE event as a JSON object
                    try:
                        event_data = json.loads(chunk)
                        event_type = event_data.get("type")
                        
                        # Print progress updates for the hackathon demo
                        if event_type == "PROGRESS":
                            print(f"  🔄 Agent thinking: {event_data.get('purpose')}")
                            
                        # Catch the final payload
                        elif event_type == "COMPLETE":
                            print("\n📥 Stream complete. Extracting the songs...")
                            
                            # Grab the result (could be a string OR already a list!)
                            final_data = event_data.get("result", {}).get("result", "")
                            
                            if isinstance(final_data, str):
                                # It's a string. Strip out the ```json and ``` markdown formatting
                                clean_json_str = final_data.replace("```json", "").replace("```", "").strip()
                                parsed_json = json.loads(clean_json_str)
                            elif isinstance(final_data, list):
                                # It's already a parsed list! No cleaning needed.
                                parsed_json = final_data
                            else:
                                parsed_json = final_data # Fallback if it's some other JSON structure
                                
                            # Save it directly to the React folder
                            os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
                            with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                                json.dump(parsed_json, f, indent=2)
                                
                            print(f"✅ Success! Saved {len(parsed_json)} songs directly to: {OUTPUT_FILE}")
                            
                    except json.JSONDecodeError:
                        # Ignore any weird chunks that aren't JSON
                        pass

    except httpx.HTTPStatusError as e:
        print(f"❌ HTTP Error connecting to TinyFish: {e.response.status_code}")
    except Exception as e:
        print(f"❌ An unexpected error occurred: {e}")

async def main():
    async with httpx.AsyncClient() as client:
        await asyncio.gather(*[process_url(client, url) for url in urls])

if __name__ == "__main__":
    asyncio.run(main())