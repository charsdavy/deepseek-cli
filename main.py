#!/usr/bin/env python3
import os
import sys
import argparse
import json
import getpass
import webbrowser
from pathlib import Path
from openai import OpenAI

# ======= Terminal Styling =======
try:
    from rich.console import Console
    from rich.panel import Panel
    has_rich = True
    console = Console()
except ImportError:
    has_rich = False

# ======= Core Configurations =======
BASE_URL = "https://api.deepseek.com"
AVAILABLE_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"]
DEFAULT_MODEL = "deepseek-v4-pro"
CONFIG_DIR = Path.home() / ".deepseek-cli"
CONFIG_FILE = CONFIG_DIR / "config.json"

# ======= Helper Functions =======
def print_system(text, style="bold blue"):
    if has_rich: console.print(text, style=style)
    else: print(text)

def print_error(text):
    if has_rich: console.print(Panel(text, title="Error", style="bold red"))
    else: print(f"\n[Error] {text}\n")

# ======= Authentication Logic =======
def get_api_key():
    """Retrieve API Key: check environment variable first, then local config."""
    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if api_key:
        return api_key

    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r") as f:
                config = json.load(f)
                return config.get("api_key")
        except Exception:
            pass
    
    return None

def interactive_auth():
    """Interactive flow to configure API Key."""
    print_system("\n🔒 Initiating API Key configuration...")
    print_system("A DeepSeek API Key is required to communicate with the model.")
    
    if input("\n👉 Press [Enter] to open browser and get a key, or type 'n' to enter manually: ").lower() != 'n':
        print_system("Opening DeepSeek Platform...")
        webbrowser.open("https://platform.deepseek.com/api_keys")
    
    while True:
        api_key = getpass.getpass("\n🔑 Paste your API Key here (input is hidden): ").strip()
        
        if api_key.startswith("sk-") and len(api_key) > 20:
            break
        print_error("Invalid API Key format. It usually starts with 'sk-'. Please try again.")
        
    CONFIG_DIR.mkdir(exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        json.dump({"api_key": api_key}, f)
        
    print_system(f"✅ Configuration saved successfully to: {CONFIG_FILE}\n")
    return api_key

def setup_auth(force_reauth=False):
    """Validate and setup authentication."""
    if force_reauth:
        return interactive_auth()
        
    api_key = get_api_key()
    if not api_key:
        print_system("🔒 No API Key detected. Starting initial setup...")
        api_key = interactive_auth()
    return api_key

# ======= Core Chat Logic =======
def chat_with_stream(client, messages, model, reasoning):
    try:
        extra_body = {"thinking": {"type": "enabled"}} if reasoning else None
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
            reasoning_effort="high" if reasoning else None,
            extra_body=extra_body
        )

        print_system("\n🤖 DeepSeek: ", style="bold green")
        full_response = ""
        for chunk in response:
            content = chunk.choices[0].delta.content
            if content:
                print(content, end="", flush=True)
                full_response += content
        print("\n")
        return full_response
    except Exception as e:
        if "401" in str(e):
            print_error("Authentication failed (401 Unauthorized). Your API Key might be invalid or revoked.\nRun `deepseek auth` to reconfigure.")
        else:
            print_error(f"API request failed: {str(e)}")
        return None

def interactive_mode(client, model, system_prompt, reasoning):
    print_system(f"🚀 Welcome to DeepSeek CLI (Model: {model})", style="bold magenta")
    if reasoning: print_system("🧠 Reasoning Mode: Enabled", style="bold yellow")
    print_system("💡 Tip: Type 'exit' to quit, 'clear' to wipe context memory.")
    print_system("-" * 50, style="dim")
    
    messages = [{"role": "system", "content": system_prompt}] if system_prompt else []
        
    while True:
        try:
            user_input = console.input("\n[bold cyan]👤 You:[/bold cyan] ").strip() if has_rich else input("\n👤 You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print_system("\nGoodbye! 👋")
            break
            
        if user_input.lower() in ['exit', 'quit']:
            print_system("Goodbye! 👋")
            break
        elif user_input.lower() == 'clear':
            messages = [{"role": "system", "content": system_prompt}] if system_prompt else []
            print_system("🧹 Context memory cleared.")
            continue
        elif not user_input: continue
            
        messages.append({"role": "user", "content": user_input})
        reply = chat_with_stream(client, messages, model, reasoning)
        if reply: messages.append({"role": "assistant", "content": reply})

def main():
    # 1. Create the top-level parser
    parser = argparse.ArgumentParser(description="A powerful command-line interface for DeepSeek API.")
    
    # 2. Add subparsers (for commands like 'auth')
    subparsers = parser.add_subparsers(dest="command", help="Available sub-commands")
    
    # 3. Create the parser for the "auth" command
    auth_parser = subparsers.add_parser("auth", help="Configure or update your DeepSeek API Key interactively")
    
    # 4. Add arguments for the main chat command (we make prompt optional so `deepseek` alone starts interactive mode)
    parser.add_argument("prompt", nargs="?", help="Execute a single query. Omit to enter interactive chat mode.")
    parser.add_argument(
        "-m", "--model", 
        default=DEFAULT_MODEL, 
        choices=AVAILABLE_MODELS,
        help=f"Specify the model. Choices: {', '.join(AVAILABLE_MODELS)} (default: {DEFAULT_MODEL})"
    )
    parser.add_argument("-s", "--system", help="System prompt to set the AI's behavior")
    parser.add_argument("-r", "--reasoning", action="store_true", help="Enable reasoning mode for complex logic")
    
    args = parser.parse_args()
    
    # ======= Route Commands =======
    
    # If the user typed `deepseek auth`
    if args.command == "auth":
        setup_auth(force_reauth=True)
        sys.exit(0)
        
    # Default flow: Chat (either single prompt or interactive)
    api_key = setup_auth()
    client = OpenAI(api_key=api_key, base_url=BASE_URL)

    # Note: Because 'auth' is now a sub-command, args.prompt won't accidentally catch it.
    if args.prompt:
        messages = [{"role": "system", "content": args.system}] if args.system else []
        messages.append({"role": "user", "content": args.prompt})
        chat_with_stream(client, messages, args.model, args.reasoning)
    else:
        interactive_mode(client, args.model, args.system, args.reasoning)

if __name__ == "__main__":
    main()