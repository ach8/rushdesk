from typing import List, Optional, Literal
from pydantic import BaseModel, Field

class OrderItemInput(BaseModel):
    menu_item_id: str = Field(
        ...,
        description="Identifiant de l'article du menu (ex: 'classic_burger', 'fries_crispy', 'coke_regular')"
    )
    quantity: int = Field(
        default=1,
        ge=1,
        le=50,
        description="Quantité commandée pour cet article"
    )
    notes: Optional[str] = Field(
        default=None,
        description="Demandes particulières (ex: 'sans oignon', 'sauce barbecue', 'glacons')"
    )

class SubmitOrderArgs(BaseModel):
    items: List[OrderItemInput] = Field(
        ...,
        description="Liste des articles validés par le client"
    )
    order_type: Literal["DINE_IN", "TAKEAWAY", "DELIVERY"] = Field(
        default="TAKEAWAY",
        description="Type de commande : sur place (DINE_IN), à emporter (TAKEAWAY) ou livraison (DELIVERY)"
    )
    customer_name: Optional[str] = Field(
        default=None,
        description="Nom ou prénom du client si communiqué"
    )
    order_notes: Optional[str] = Field(
        default=None,
        description="Remarques générales sur la commande"
    )

# Définition de l'outil au format Gemini Function Declaration
SUBMIT_ORDER_TOOL_DECLARATION = {
    "name": "submit_order",
    "description": "Envoie la commande confirmée par le client en cuisine sur le tableau de bord RushDesk.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "items": {
                "type": "ARRAY",
                "description": "Liste des articles commandés",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "menu_item_id": {
                            "type": "STRING",
                            "description": "Identifiant exact de l'article (ex: classic_burger, fries_crispy, coke_regular, pizza_marg, salad_caesar)"
                        },
                        "quantity": {
                            "type": "INTEGER",
                            "description": "Nombre d'exemplaires"
                        },
                        "notes": {
                            "type": "STRING",
                            "description": "Précisions ou personnalisations (sans oignon, bien cuit, etc.)"
                        }
                    },
                    "required": ["menu_item_id", "quantity"]
                }
            },
            "order_type": {
                "type": "STRING",
                "enum": ["DINE_IN", "TAKEAWAY", "DELIVERY"],
                "description": "Type de commande"
            },
            "customer_name": {
                "type": "STRING",
                "description": "Nom du client"
            },
            "order_notes": {
                "type": "STRING",
                "description": "Notes générales"
            }
        },
        "required": ["items", "order_type"]
    }
}
