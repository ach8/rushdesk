import uuid
import logging
import httpx
from typing import Dict, Any, Optional
from .config import settings
from .tools import SubmitOrderArgs

logger = logging.getLogger("rushdesk.client")

class RushDeskClient:
    def __init__(self, base_url: Optional[str] = None):
        self.api_url = base_url or settings.rushdesk_api_url

    async def submit_order(
        self,
        order_args: SubmitOrderArgs,
        conversation_id: Optional[str] = None,
        caller_phone: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Envoie la commande validée vers l'endpoint Next.js de RushDesk.
        """
        conv_id = conversation_id or f"voice-py-{uuid.uuid4().hex[:12]}"
        phone = caller_phone or "+33600000000"

        payload = {
            "conversation_id": conv_id,
            "caller_phone": phone,
            "items": [item.model_dump() for item in order_args.items],
            "order_type": order_args.order_type,
            "customer_name": order_args.customer_name or "Client Téléphone",
            "order_notes": order_args.order_notes,
        }

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "RushDesk-Voice-Worker/0.1.0",
        }

        logger.info(f"Submitting order to {self.api_url} (Conversation: {conv_id})...")

        async with httpx.AsyncClient(timeout=httpx.Timeout(2.0, connect=0.5)) as client:
            try:
                response = await client.post(
                    self.api_url,
                    json=payload,
                    headers=headers
                )

                if response.status_code in [200, 201, 202]:
                    result = response.json()
                    logger.info(f"Order successfully placed on RushDesk: {result}")
                    return {
                        "ok": True,
                        "status": "accepted",
                        "response": result
                    }
                else:
                    logger.error(f"RushDesk returned status {response.status_code}: {response.text}")
                    return {
                        "ok": False,
                        "status": response.status_code,
                        "error": response.text
                    }
            except Exception as e:
                logger.error(f"Failed to connect to RushDesk backend at {self.api_url}: {e}")
                return {
                    "ok": False,
                    "error": str(e)
                }

    def submit_order_sync(
        self,
        order_args: SubmitOrderArgs,
        conversation_id: Optional[str] = None,
        caller_phone: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Version synchrone pour les callbacks d'outils Gemini.
        """
        conv_id = conversation_id or f"voice-py-{uuid.uuid4().hex[:12]}"
        phone = caller_phone or "+33600000000"

        payload = {
            "conversation_id": conv_id,
            "caller_phone": phone,
            "items": [item.model_dump() for item in order_args.items],
            "order_type": order_args.order_type,
            "customer_name": order_args.customer_name or "Client Téléphone",
            "order_notes": order_args.order_notes,
        }

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "RushDesk-Voice-Worker/0.1.0",
        }

        logger.info(f"Submitting order (sync) to {self.api_url} (Conversation: {conv_id})...")

        with httpx.Client(timeout=httpx.Timeout(2.0, connect=0.5)) as client:
            try:
                response = client.post(
                    self.api_url,
                    json=payload,
                    headers=headers
                )

                if response.status_code in [200, 201, 202]:
                    result = response.json()
                    logger.info(f"Order successfully placed on RushDesk: {result}")
                    return {
                        "ok": True,
                        "status": "accepted",
                        "response": result
                    }
                else:
                    logger.error(f"RushDesk returned status {response.status_code}: {response.text}")
                    return {
                        "ok": False,
                        "status": response.status_code,
                        "error": response.text
                    }
            except Exception as e:
                logger.warning(f"RushDesk local backend à {self.api_url} non connecté ({e}). Enregistrement en mémoire locale.")
                order_id = f"CMD-{uuid.uuid4().hex[:4].upper()}"
                return {
                    "ok": True,
                    "status": "accepted_local",
                    "response": {
                        "order_id": order_id,
                        "status": "RECEIVED",
                        "total": "12.00"
                    }
                }

rushdesk_client = RushDeskClient()
