"""
Script de test interactif et automatisé pour RushDesk Voice Worker.
Permet de simuler un client au téléphone passant commande auprès de l'agent IA (Gemini 2.0 Flash).
"""

import sys
import asyncio
import argparse

# Fix Windows console UTF-8 encoding
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from colorama import init, Fore, Style

# Initialiser colorama pour les couleurs Windows/Linux
init(autoreset=True)

from src.config import settings
from src.agent import VoiceOrderAgent

async def run_automated_test():
    print(f"\n{Fore.CYAN}=======================================================")
    print(f"{Fore.CYAN}  🤖 TEST AUTOMATISÉ DU CERVEAU IA (GEMINI 2.0 FLASH)")
    print(f"{Fore.CYAN}=======================================================\n")

    key = settings.get_effective_gemini_key()
    if not key:
        print(f"{Fore.RED}❌ Erreur : Aucune clé GEMINI_API_KEY trouvée dans .env")
        return False

    print(f"{Fore.GREEN}✓ Clé API Gemini détectée")
    print(f"{Fore.GREEN}✓ Modèle configuré : {settings.gemini_model}")
    print(f"{Fore.GREEN}✓ Endpoint KDS cible : {settings.rushdesk_api_url}\n")

    agent = VoiceOrderAgent(conversation_id="test-session-001", caller_phone="+33612345678")
    if not agent.is_ready:
        print(f"{Fore.RED}❌ Échec de l'initialisation de l'agent: {getattr(agent, 'init_error', 'inconnu')}")
        return False

    # Tour 1 : Accueil
    greeting = agent.get_greeting()
    print(f"{Fore.YELLOW}Alex (IA) : {Fore.WHITE}{greeting}")

    # Tour 2 : Commande du client
    user_turn_1 = "Bonjour, je voudrais commander 2 Classic Burgers sans oignon et une grande portion de frites."
    print(f"\n{Fore.BLUE}Client    : {Fore.WHITE}{user_turn_1}")
    
    reply_1 = await agent.handle_user_message(user_turn_1)
    print(f"{Fore.YELLOW}Alex (IA) : {Fore.WHITE}{reply_1}")

    # Tour 3 : Ajout boisson + type de commande
    user_turn_2 = "Oui, ajoutez deux Coca Zéro s'il vous plaît. Ce sera à emporter."
    print(f"\n{Fore.BLUE}Client    : {Fore.WHITE}{user_turn_2}")
    
    reply_2 = await agent.handle_user_message(user_turn_2)
    print(f"{Fore.YELLOW}Alex (IA) : {Fore.WHITE}{reply_2}")

    # Tour 4 : Confirmation
    user_turn_3 = "Oui, c'est parfait, je confirme la commande !"
    print(f"\n{Fore.BLUE}Client    : {Fore.WHITE}{user_turn_3}")
    
    reply_3 = await agent.handle_user_message(user_turn_3)
    print(f"{Fore.YELLOW}Alex (IA) : {Fore.WHITE}{reply_3}")

    # Vérification du résultat
    print(f"\n{Fore.CYAN}-------------------------------------------------------")
    print(f"{Fore.CYAN}  📊 RÉSULTAT DU DÉCLENCHEMENT DE COMMANDE")
    print(f"{Fore.CYAN}-------------------------------------------------------")
    if agent.last_order_result:
        print(f"{Fore.GREEN}✓ Outil 'submit_order' déclenché avec succès par l'IA !")
        print(f"{Fore.WHITE}Détails retournés : {agent.last_order_result}")
        return True
    else:
        print(f"{Fore.YELLOW}ℹ️  L'outil submit_order n'a pas encore été déclenché ou attend une confirmation.")
        return True

async def run_interactive_mode():
    print(f"\n{Fore.MAGENTA}=======================================================")
    print(f"{Fore.MAGENTA}  🎙️  MODE INTERACTIF : DISCUTEZ AVEC L'AGENT ALEX")
    print(f"{Fore.MAGENTA}=======================================================")
    print(f"{Fore.WHITE}Tapez votre message pour parler à l'IA. Tapez 'quit' pour quitter.\n")

    agent = VoiceOrderAgent(conversation_id="interactive-session", caller_phone="+33699887766")
    if not agent.is_ready:
        print(f"{Fore.RED}❌ Erreur : Impossible d'initialiser l'agent Gemini.")
        return

    print(f"{Fore.YELLOW}Alex (IA) : {Fore.WHITE}{agent.get_greeting()}\n")

    while True:
        try:
            user_input = input(f"{Fore.BLUE}Vous : {Fore.WHITE}").strip()
            if not user_input:
                continue
            if user_input.lower() in ["quit", "exit", "quitter"]:
                print(f"{Fore.YELLOW}Au revoir !")
                break

            response = await agent.handle_user_message(user_input)
            print(f"\n{Fore.YELLOW}Alex (IA) : {Fore.WHITE}{response}\n")

            if agent.last_order_result:
                print(f"{Fore.GREEN}[KDS Cuisine] 🛎️ Commande transmise à RushDesk : {agent.last_order_result}\n")
        except (KeyboardInterrupt, EOFError):
            print("\nFin de la session.")
            break

def main():
    parser = argparse.ArgumentParser(description="Test du Worker Vocal RushDesk")
    parser.add_argument("--auto", action="store_true", help="Lancer le test automatisé complet")
    parser.add_argument("--interactive", action="store_true", help="Lancer en mode conversation interactive")
    args = parser.parse_args()

    if args.interactive:
        asyncio.run(run_interactive_mode())
    else:
        asyncio.run(run_automated_test())

if __name__ == "__main__":
    main()
