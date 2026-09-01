import asyncio
import json
import logging
import uuid
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .agent import VoiceOrderAgent

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("rushdesk.server")

app = FastAPI(
    title="RushDesk Voice Worker",
    description="Serveur d'agent vocal IA haute performance pour RushDesk",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from pathlib import Path

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
shared_agent = VoiceOrderAgent(conversation_id="web-voice-tester", caller_phone="+33612345678")

@app.get("/")
async def root():
    return {
        "service": "RushDesk Voice Worker",
        "status": "online",
        "model": settings.gemini_model,
        "kds_endpoint": settings.rushdesk_api_url,
        "voice_tester_url": "http://localhost:8765/voice"
    }

@app.get("/voice", response_class=HTMLResponse)
async def voice_tester():
    html_file = TEMPLATES_DIR / "voice_tester.html"
    if html_file.exists():
        return HTMLResponse(content=html_file.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>Template voice_tester.html non trouvé</h1>")

from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from .tts import generate_neural_audio_base64, stream_neural_audio, DEFAULT_VOICE

@app.get("/api/tts")
async def tts_streaming_endpoint(text: str = "", voice: str = DEFAULT_VOICE):
    if not text:
        return Response(status_code=400)
    return StreamingResponse(
        stream_neural_audio(text, voice=voice),
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "no-cache",
            "Accept-Ranges": "bytes"
        }
    )

@app.post("/api/chat")
async def chat_api(request: Request):
    data = await request.json()
    user_message = data.get("message", "")
    voice = data.get("voice", DEFAULT_VOICE)
    skip_tts = data.get("skip_tts", False)

    if not user_message:
        return JSONResponse({"reply": "Je n'ai pas bien entendu, pouvez-vous répéter ?"})

    reply = await shared_agent.handle_user_message(user_message)
    
    audio_base64 = ""
    if not skip_tts:
        audio_base64 = await generate_neural_audio_base64(reply, voice=voice)

    return JSONResponse({
        "reply": reply,
        "audio": audio_base64,
        "last_order_result": shared_agent.last_order_result
    })

@app.get("/health")
async def health_check():
    has_gemini = bool(settings.get_effective_gemini_key())
    return {
        "status": "healthy" if has_gemini else "missing_api_key",
        "gemini_configured": has_gemini,
        "model": settings.gemini_model
    }

import urllib.parse

# Sessions de conversation par CallSid pour la téléphonie
phone_agents: dict[str, VoiceOrderAgent] = {}

def get_or_create_phone_agent(call_sid: str, caller_phone: str = "") -> VoiceOrderAgent:
    if call_sid not in phone_agents:
        phone_agents[call_sid] = VoiceOrderAgent(
            conversation_id=f"tw-{call_sid}",
            caller_phone=caller_phone or "+33600000000"
        )
    return phone_agents[call_sid]

@app.api_route("/twiml", methods=["GET", "POST"])
async def twilio_inbound_call(request: Request):
    """
    Connecte l'appelant Twilio au flux WebSocket temps réel bidirectionnel MediaStream.
    """
    form_data = await request.form() if request.method == "POST" else {}
    caller_phone = form_data.get("From", "+33600000000")

    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or f"localhost:{settings.port}"
    stream_url = f"wss://{host}/ws/twilio"

    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="{stream_url}">
            <Parameter name="caller" value="{caller_phone}" />
        </Stream>
    </Connect>
</Response>"""

    return Response(content=twiml, media_type="application/xml")

@app.api_route("/twiml/gather", methods=["GET", "POST"])
async def twilio_gather_speech(request: Request):
    """
    Reçoit la transcription de ce que le client vient de dire au téléphone.
    """
    form_data = await request.form() if request.method == "POST" else {}
    call_sid = form_data.get("CallSid", "")
    caller_phone = form_data.get("From", "+33600000000")
    user_speech = form_data.get("SpeechResult", "").strip()

    agent = get_or_create_phone_agent(call_sid, caller_phone)

    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or f"localhost:{settings.port}"
    proto = request.headers.get("x-forwarded-proto", "https")
    gather_url = f"{proto}://{host}/twiml/gather"

    if not user_speech:
        # Silence ou rien compris
        reprompt = "Pardonnez-moi, je n'ai pas bien entendu. Que souhaitez-vous commander ?"
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="speech" action="{gather_url}" method="POST" language="fr-FR" speechTimeout="1" speechModel="experimental_conversations" enhanced="true">
        <Say voice="Polly.Lea-Neural" language="fr-FR">{reprompt}</Say>
    </Gather>
    <Hangup/>
</Response>"""
        return Response(content=twiml, media_type="application/xml")

    # Envoi du message à l'agent IA Gemini 3.6 Flash
    logger.info(f"[Twilio Call {call_sid}] Client: {user_speech}")
    ai_reply = await agent.handle_user_message(user_speech)
    logger.info(f"[Twilio Call {call_sid}] Alex (IA): {ai_reply}")

    # Si la commande a été soumise au KDS et que l'IA a conclu
    is_order_finished = bool(agent.last_order_result and agent.last_order_result.get("ok"))

    if is_order_finished:
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Lea-Neural" language="fr-FR">{ai_reply}</Say>
    <Pause length="1"/>
    <Hangup/>
</Response>"""
    else:
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="speech" action="{gather_url}" method="POST" language="fr-FR" speechTimeout="1" speechModel="experimental_conversations" enhanced="true">
        <Say voice="Polly.Lea-Neural" language="fr-FR">{ai_reply}</Say>
    </Gather>
    <Redirect>{gather_url}</Redirect>
</Response>"""

    return Response(content=twiml, media_type="application/xml")

from .media_stream import TwilioCallSession

@app.websocket("/ws/twilio")
async def twilio_media_stream_ws(websocket: WebSocket):
    """
    Gestionnaire WebSocket temps réel bidirectionnel Twilio <-> Vosk <-> Gemini <-> Twilio Audio.
    """
    await websocket.accept()
    logger.info("Twilio MediaStream WebSocket connecté.")

    session: Optional[TwilioCallSession] = None
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg.get("event")

            if event == "connected":
                logger.info("Twilio MediaStream: handshake connected reçu.")
                continue

            elif event == "start":
                stream_sid = msg["start"]["streamSid"]
                call_sid = msg["start"]["callSid"]
                caller = msg["start"].get("customParameters", {}).get("caller", "+33600000000")
                logger.info(f"Démarrage session MediaStream pour call {call_sid}, caller {caller}")
                session = TwilioCallSession(websocket, call_sid, stream_sid, caller)
                await session.start()
                
                # Message d'accueil immédiat au décroché
                greeting = session.agent.get_greeting()
                asyncio.create_task(session.speak_text(greeting, session.generation_id))

            elif event == "media":
                if session and session.is_running:
                    payload_b64 = msg["media"]["payload"]
                    await session.process_media_chunk(payload_b64)

            elif event == "stop":
                logger.info("Twilio MediaStream: appel terminé (stop event).")
                break

    except WebSocketDisconnect:
        logger.info("WebSocket Twilio fermé.")
    except Exception as e:
        logger.error(f"Erreur WebSocket MediaStream: {e}", exc_info=True)
    finally:
        if session:
            session.is_running = False
            if session.deepgram:
                await session.deepgram.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.server:app", host=settings.host, port=settings.port, reload=True)
