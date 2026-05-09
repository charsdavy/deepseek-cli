#!/usr/bin/env python3
import os
import sys
import argparse
from openai import OpenAI

try:
    from rich.console import Console
    from rich.panel import Panel
    has_rich = True
    console = Console()
except ImportError:
    has_rich = False

API_KEY = os.environ.get("DEEPSEEK_API_KEY")
BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-pro" 

def print_system(text, style="bold blue"):
    if has_rich: console.print(text, style=style)
    else: print(text)

def print_error(text):
    if has_rich: console.print(Panel(text, title="Error", style="bold red"))
    else: print(f"\n[错误] {text}\n")

def check_env():
    if not API_KEY:
        print_error("未找到 DEEPSEEK_API_KEY 环境变量。\n请配置: export DEEPSEEK_API_KEY='你的API_KEY'")
        sys.exit(1)

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
        print_error(f"API 请求失败: {str(e)}")
        return None

def interactive_mode(client, model, system_prompt, reasoning):
    print_system(f"🚀 欢迎使用 DeepSeek CLI (模型: {model})", style="bold magenta")
    if reasoning: print_system("🧠 深度思考模式: 已开启", style="bold yellow")
    print_system("💡 提示: 输入 'exit' 退出，输入 'clear' 清空记忆。")
    print_system("-" * 50, style="dim")
    
    messages = [{"role": "system", "content": system_prompt}] if system_prompt else []
        
    while True:
        try:
            user_input = console.input("\n[bold cyan]👤 You:[/bold cyan] ").strip() if has_rich else input("\n👤 You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print_system("\n再见！👋")
            break
            
        if user_input.lower() in ['exit', 'quit']:
            print_system("再见！👋")
            break
        elif user_input.lower() == 'clear':
            messages = [{"role": "system", "content": system_prompt}] if system_prompt else []
            print_system("🧹 上下文已清空。")
            continue
        elif not user_input: continue
            
        messages.append({"role": "user", "content": user_input})
        reply = chat_with_stream(client, messages, model, reasoning)
        if reply: messages.append({"role": "assistant", "content": reply})

def main():
    parser = argparse.ArgumentParser(description="DeepSeek 命令行交互工具")
    parser.add_argument("prompt", nargs="?", help="单次问答。例如: deepseek '解释相对论'")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help=f"指定模型 (默认: {DEFAULT_MODEL})")
    parser.add_argument("-s", "--system", help="系统提示词")
    parser.add_argument("-r", "--reasoning", action="store_true", help="开启深度思考模式")
    
    args = parser.parse_args()
    check_env()
    
    client = OpenAI(api_key=API_KEY, base_url=BASE_URL)

    if args.prompt:
        messages = [{"role": "system", "content": args.system}] if args.system else []
        messages.append({"role": "user", "content": args.prompt})
        chat_with_stream(client, messages, args.model, args.reasoning)
    else:
        interactive_mode(client, args.model, args.system, args.reasoning)

if __name__ == "__main__":
    main()