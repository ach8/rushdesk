import asyncio
import time
from src.agent import VoiceOrderAgent
from src.tts import stream_neural_audio

async def test():
    print("\n--- TEST DE LATENCE COMPOSANT PAR COMPOSANT ---")
    agent = VoiceOrderAgent(conversation_id="bench", caller_phone="+3312345678")
    
    t0 = time.perf_counter()
    reply = await agent.handle_user_message("Bonjour, que proposez-vous au menu ?")
    t_llm = time.perf_counter()
    llm_ms = (t_llm - t0) * 1000
    print(f"1. [LLM] Gemini 3.5 Flash-Lite : {llm_ms:.0f} ms")
    print(f"   Reponse : '{reply}'")
    
    t1 = time.perf_counter()
    t_first_audio = None
    async for chunk in stream_neural_audio(reply, voice="fr-FR-VivienneMultilingualNeural"):
        if t_first_audio is None:
            t_first_audio = time.perf_counter()
    t_end_audio = time.perf_counter()
    
    tts_first_ms = (t_first_audio - t1) * 1000 if t_first_audio else 0
    tts_total_ms = (t_end_audio - t1) * 1000
    print(f"2. [TTS] Edge-TTS Premier paquet audio : {tts_first_ms:.0f} ms")
    print(f"3. [TTS] Edge-TTS Telechargement complet : {tts_total_ms:.0f} ms")
    
    total_backend = (t_first_audio - t0) * 1000 if t_first_audio else 0
    print(f"\n[RESULTAT] TEMPS TOTAL DU BACKEND (LLM + Debut Audio) : {total_backend:.0f} ms ({total_backend/1000:.2f} s)\n")

if __name__ == "__main__":
    asyncio.run(test())
