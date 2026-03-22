import os
import json
import anthropic

    
def load_prompt(file_path):
    with open(file_path) as f:
        return f.read()


async def get_coach_response(session_json: str) -> str:
    """Call Claude and return appropriate response based on request type."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return "Coach is offline. Add ANTHROPIC_API_KEY to your .env file."

    print("key is read")
    
    # Parse the incoming data to detect request kind
    try:
        data = json.loads(session_json)
        request_kind = data.get('request_kind', 'chat')
        user_message = data.get('message', '')
        coach_payload = data.get('coach_payload', {})
    except json.JSONDecodeError:
        request_kind = 'chat'
        user_message = session_json
        coach_payload = {}

    client = anthropic.AsyncAnthropic(api_key=api_key)
    
    # Different system prompts for different request types
    if request_kind == 'full_session':
        system_prompt = load_prompt("prompt/system_prompt.txt")
        user_content = load_prompt('prompt/user_message_template.txt').format(
            session_json=json.dumps(coach_payload)
        )
    else:  # 'chat' mode - short encouraging feedback
        system_prompt = """You are Tempo Coach, an encouraging piano teacher. 
Give SHORT, one-sentence encouraging feedback based on their current practice session. 
Be warm and specific. Examples: "Great job nailing that tricky passage!", "Your timing is getting better!", "Nice effort today!".
Never give long explanations in chat mode — just a quick positive note."""
        
        # For regular chat, just use their message and basic stats
        user_content = f"""Current session stats:
- Played notes: {coach_payload.get('session_context', {}).get('played_notes_count', 0)}
- Correct notes: {coach_payload.get('session_context', {}).get('correct_played_notes_count', 0)}
- Friendly score: {coach_payload.get('session_context', {}).get('friendly_score_percent', 0)}%
- Skipped notes: {coach_payload.get('session_context', {}).get('skipped_notes_count', 0)}
- Song: {coach_payload.get('exercise', {}).get('name', 'Unknown')}

User message: {user_message}

Remember: One sentence maximum!"""

    message = await client.messages.create(
        model       = "claude-haiku-4-5-20251001",
        max_tokens  = 1024 if request_kind == 'full_session' else 150,
        temperature = 0.7,
        system      = system_prompt,
        messages    = [
            {
                "role": "user",
                "content": user_content
            }
        ]
    )
    return message.content[0].text