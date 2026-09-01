import os
import json
import logging
from typing import List, Dict, Any, Optional
from google import genai
from google.genai import types

from .config import settings
from .prompts import RESTAURANT_VOICE_SYSTEM_PROMPT
from .tools import SubmitOrderArgs, OrderItemInput
from .client_rushdesk import rushdesk_client

logger = logging.getLogger("rushdesk.agent")

class VoiceOrderAgent:
    def __init__(
        self,
        api_key: Optional[str] = None,
        model_name: Optional[str] = None,
        conversation_id: Optional[str] = None,
        caller_phone: Optional[str] = None,
    ):
        self.api_key = api_key or settings.get_effective_gemini_key()
        self.model_name = model_name or settings.gemini_model
        self.conversation_id = conversation_id
        self.caller_phone = caller_phone
        self.last_order_result: Optional[Dict[str, Any]] = None
        self._init_client()

    def _init_client(self):
        """Initialise le client Google GenAI (SDK moderne) en mode Asynchrone."""
        try:
            self.client = genai.Client(api_key=self.api_key)

            from pydantic import BaseModel, Field

            class OrderItemParam(BaseModel):
                menu_item_id: str = Field(description="Identifiant article ex: 'classic_burger', 'pizza_margherita', 'fries_crispy', 'coke_regular', 'salad_caesar'")
                quantity: int = Field(default=1, description="Quantité d'articles")
                notes: Optional[str] = Field(default=None, description="Notes ou options particulières")

            # Définition du tool callable pour Gemini
            def submit_order(
                items: list[OrderItemParam],
                order_type: str = "TAKEAWAY",
                customer_name: Optional[str] = None,
                order_notes: Optional[str] = None
            ) -> dict:
                """
                Envoie la commande confirmée par le client en cuisine sur le tableau de bord RushDesk.
                Paramètres:
                  - items: Liste d'articles avec 'menu_item_id' (ex: 'classic_burger', 'fries_crispy', 'coke_regular', 'pizza_margherita', 'salad_caesar') et 'quantity'.
                  - order_type: 'TAKEAWAY' (à emporter), 'DINE_IN' (sur place) ou 'DELIVERY' (livraison).
                  - customer_name: Nom du client optionnel.
                  - order_notes: Notes particulières.
                """
                logger.info(f"submit_order tool called: items={items}, order_type={order_type}")
                
                # Normalisation des articles
                normalized_items = []
                for it in items:
                    m_id = it.menu_item_id if hasattr(it, "menu_item_id") else getattr(it, "id", "classic_burger")
                    qty = it.quantity if hasattr(it, "quantity") else 1
                    notes = getattr(it, "notes", None)
                    normalized_items.append(OrderItemInput(menu_item_id=str(m_id), quantity=int(qty), notes=notes))

                parsed_args = SubmitOrderArgs(
                    items=normalized_items,
                    order_type=order_type if order_type in ["TAKEAWAY", "DINE_IN", "DELIVERY"] else "TAKEAWAY",
                    customer_name=customer_name or "Client Téléphone",
                    order_notes=order_notes
                )

                # Soumission de la commande via client sync
                order_result = rushdesk_client.submit_order_sync(
                    order_args=parsed_args,
                    conversation_id=self.conversation_id,
                    caller_phone=self.caller_phone
                )
                self.last_order_result = order_result
                logger.info(f"Order submission result: {order_result}")

                order_id = order_result.get("response", {}).get("order_id", "CMD-01")
                total = order_result.get("response", {}).get("total", "12.00")
                return {
                    "status": "success",
                    "order_id": order_id,
                    "total": total,
                    "message": f"Commande {order_id} enregistrée avec succès et transmise en cuisine."
                }

            self._submit_order_fn = submit_order

            self.chat = self.client.aio.chats.create(
                model=self.model_name,
                config=types.GenerateContentConfig(
                    system_instruction=RESTAURANT_VOICE_SYSTEM_PROMPT,
                    tools=[self._submit_order_fn],
                    temperature=0.7,
                )
            )
            self.is_ready = True
            logger.info(f"Gemini agent initialized with model {self.model_name} (AIO)")
        except Exception as e:
            logger.error(f"Failed to initialize Gemini client: {e}", exc_info=True)
            self.is_ready = False
            self.init_error = str(e)

    async def handle_user_message_stream(self, user_text: str):
        """
        Traite un tour de conversation avec Gemini et génère la réponse fluide.
        """
        if not self.is_ready:
            yield "Désolé, le service de commande vocale rencontre un problème technique. Veuillez réessayer dans un instant."
            return

        try:
            response = await self.chat.send_message(user_text)
            if response.text:
                yield response.text
        except Exception as e:
            logger.error(f"Error in handle_user_message_stream: {e}", exc_info=True)
            yield "Pardonnez-moi, pouvez-vous répéter votre demande s'il vous plaît ?"

    async def handle_user_message(self, user_text: str) -> str:
        """Traite un tour de conversation et retourne la réponse complète sous forme de chaîne."""
        chunks = []
        async for piece in self.handle_user_message_stream(user_text):
            chunks.append(piece)
        return "".join(chunks).strip()

    def get_greeting(self) -> str:
        return "Bonjour et bienvenue chez RushDesk ! Je suis Alex. Que puis-je vous préparer aujourd'hui ?"
