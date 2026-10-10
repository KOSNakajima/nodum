"""Adapters for the AI providers a user can bring a key for — on LangChain.

One shape in, one shape out: messages and a system prompt go in; text deltas,
tool calls and (with thinking on) reasoning come out. LangChain's chat models
carry each provider's wire format — tool-call schemas, message history,
streaming, the Responses API — so adding a provider or a capability is a
constructor argument here rather than another hand-written protocol.

What LangChain does not do for us stays here, because everything in this
module talks to a THIRD PARTY with the USER'S key:

- a user-supplied base_url is checked against private networks before every
  request (`_checked_base_url`);
- failures are mapped to fixed messages and never echo a provider's error body,
  which can quote the key (`_provider_error`);
- every request is time-bounded and there are no silent retries.
"""

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    message_chunk_to_message,
)
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from app.settings import get_settings
from app.utils.url_guard import UnsafeUrlError, assert_safe_url


@dataclass(frozen=True)
class ProviderInfo:
    """What the settings UI needs to offer a provider."""

    id: str
    label: str
    default_model: str
    models: tuple[str, ...]
    key_url: str


# Model lists are a convenience, not a gate: the UI also accepts a typed model
# name, because providers ship new ones faster than we ship releases.
PROVIDERS: dict[str, ProviderInfo] = {
    "anthropic": ProviderInfo(
        id="anthropic",
        label="Claude (Anthropic)",
        default_model="claude-sonnet-4-5",
        models=("claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"),
        key_url="https://console.anthropic.com/settings/keys",
    ),
    "openai": ProviderInfo(
        id="openai",
        label="OpenAI",
        default_model="gpt-4.1",
        models=("gpt-4.1", "gpt-4.1-mini", "o4-mini"),
        key_url="https://platform.openai.com/api-keys",
    ),
    "gemini": ProviderInfo(
        id="gemini",
        label="Gemini (Google)",
        default_model="gemini-2.5-flash",
        models=("gemini-2.5-pro", "gemini-2.5-flash"),
        key_url="https://aistudio.google.com/app/apikey",
    ),
    "qwen": ProviderInfo(
        id="qwen",
        label="Qwen (Alibaba)",
        default_model="qwen-plus",
        models=("qwen-max", "qwen-plus", "qwen-turbo"),
        key_url="https://bailian.console.alibabacloud.com/",
    ),
}

_DEFAULT_BASE_URLS = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "qwen": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
}


class ProviderError(RuntimeError):
    """A provider refused or failed. The message is safe to show the user."""


def base_url_for(provider: str, override: str | None) -> str:
    return (override or _DEFAULT_BASE_URLS[provider]).rstrip("/")


async def _checked_base_url(provider: str, override: str | None) -> str:
    """Resolve the provider root, refusing an override that points somewhere
    the server must not reach.

    Enforced here and not only in save_credential: a save-time check misses
    every credential stored before the guard existed, and a hostname is free to
    resolve differently on the second lookup. Built-in defaults skip the check
    — they are ours, and resolving them on every call would add a DNS round
    trip to the hot path.
    """
    if not override:
        return _DEFAULT_BASE_URLS[provider].rstrip("/")
    try:
        await assert_safe_url(override, allow_private=get_settings().AI_ALLOW_PRIVATE_BASE_URLS)
    except UnsafeUrlError as exc:
        raise ProviderError(str(exc)) from exc
    return override.rstrip("/")


def _status_error(provider: str, status: int, param: str | None = None) -> ProviderError:
    """A fixed, key-free message for an HTTP failure. Status codes — and, for a
    400, the name of the parameter the provider objected to, which is always
    one of ours — are enough to say something useful."""
    if status in (401, 403):
        return ProviderError("The provider rejected the API key. Check it in Settings → AI.")
    if status == 404:
        return ProviderError("The provider does not know that model. Pick another in Settings → AI.")
    if status == 400 and param in ("reasoning_effort", "reasoning", "reasoning.effort"):
        return ProviderError(
            "This model does not accept that reasoning setting. Turn thinking off or lower the effort."
        )
    if status == 429:
        return ProviderError("The provider is rate-limiting this key. Try again shortly.")
    if status >= 500:
        return ProviderError(f"{provider} is having trouble right now ({status}).")
    return ProviderError(f"The provider rejected the request ({status}).")


def _provider_error(provider: str, exc: BaseException) -> ProviderError:
    """Map whatever the provider SDK under LangChain raised to a ProviderError.

    The OpenAI and Anthropic SDKs raise `APIStatusError` (`status_code`, and
    OpenAI's `param`); google-genai raises `APIError` (`code`). Their messages
    can quote the request, so only those fields are read — never `str(exc)`.
    """
    if isinstance(exc, ProviderError):
        return exc
    status = getattr(exc, "status_code", None)
    if not isinstance(status, int):
        status = getattr(exc, "code", None)
    if isinstance(status, int) and 400 <= status < 600:
        param = getattr(exc, "param", None)
        return _status_error(provider, status, param if isinstance(param, str) else None)
    name = type(exc).__name__.lower()
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)) or "timeout" in name:
        return ProviderError("The provider took too long to answer.")
    return ProviderError("Could not reach the provider.")


#: Providers whose chat request takes a reasoning effort (the levels are the
#: API's VaultChatRequest.reasoning_effort). OpenAI-compatible endpoints, Azure
#: included; Claude's and Gemini's thinking controls are a constructor argument
#: away now, but untested against real keys, so not offered yet.
REASONING_PROVIDERS = frozenset({"openai"})
#: Reasoning tokens count against the output cap, so a reply with reasoning on
#: needs far more room than 2048 or it is all thinking and no answer. Billing
#: follows what is used, not this ceiling.
REASONING_MAX_TOKENS = 16_384


@dataclass
class ToolCall:
    """A provider-neutral request to run one of our vault tools."""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class Reasoning:
    """A piece of the model's reasoning summary, streamed while it thinks."""

    text: str


@dataclass
class Turn:
    """One provider response: some text, and/or some tool calls."""

    text: str
    tool_calls: list[ToolCall]
    # The assistant message to echo back in the next request: a LangChain
    # AIMessage, which carries whatever the provider needs (tool-call ids,
    # Anthropic content blocks, Gemini parts) without us rebuilding it.
    raw_message: Any = None
    # How many tokens the model spent reasoning — 0 when it chose not to, which
    # reasoning models do for easy questions even with thinking on.
    reasoning_tokens: int = 0


def _tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Our neutral declarations as OpenAI function tools — the form every
    LangChain chat model's bind_tools converts to its provider's own."""
    return [
        {
            "type": "function",
            "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]},
        }
        for t in tools
    ]


def _chat_model(
    provider: str,
    *,
    api_key: str,
    model: str,
    url_root: str,
    custom_base_url: bool,
    max_tokens: int,
    reasoning_effort: str | None,
    http_client: httpx.AsyncClient,
) -> BaseChatModel:
    """The LangChain chat model for one request: bounded in time, no retries,
    pointed at the checked root."""
    timeout = float(get_settings().AI_REQUEST_TIMEOUT)
    key = SecretStr(api_key)
    if provider == "anthropic":
        return ChatAnthropic(
            model=model,
            api_key=key,
            base_url=url_root,
            max_tokens=max_tokens,
            default_request_timeout=timeout,
            max_retries=0,
        )
    if provider == "gemini":
        # google-genai builds its own versioned paths, so only a user's
        # override (already checked) is passed through.
        return ChatGoogleGenerativeAI(
            model=model,
            google_api_key=key,
            base_url=url_root if custom_base_url else None,
            max_output_tokens=max_tokens,
            timeout=timeout,
            max_retries=0,
        )
    options: dict[str, Any] = {
        "model": model,
        "api_key": key,
        "base_url": url_root,
        "timeout": timeout,
        "max_retries": 0,
        # Ours rather than the SDK's default: the same time bound, closed when
        # the request ends, and the seam the tests swap the transport through.
        "http_async_client": http_client,
    }
    if provider == "openai":
        # Sent as max_completion_tokens — reasoning models (GPT-5, o-series,
        # Azure's v1 endpoint) reject the older max_tokens.
        options["max_tokens"] = max_tokens
        if reasoning_effort and provider in REASONING_PROVIDERS:
            # Thinking on: the Responses API, the only OpenAI endpoint that
            # returns a reasoning summary to show. store=False keeps the
            # conversation off the provider; the reasoning it needs between
            # tool rounds travels back encrypted instead.
            options["use_responses_api"] = True
            options["reasoning"] = {"effort": reasoning_effort, "summary": "auto"}
            options["store"] = False
            options["include"] = ["reasoning.encrypted_content"]
    else:
        # Qwen's compatible mode documents only the older name.
        options["extra_body"] = {"max_tokens": max_tokens}
    return ChatOpenAI(**options)


async def _model_for(
    provider: str,
    *,
    api_key: str,
    model: str,
    base_url: str | None,
    max_tokens: int,
    http_client: httpx.AsyncClient,
    reasoning_effort: str | None = None,
) -> BaseChatModel:
    if provider not in PROVIDERS:
        raise ProviderError(f"Unknown provider: {provider}")
    url_root = await _checked_base_url(provider, base_url)
    return _chat_model(
        provider,
        api_key=api_key,
        model=model,
        url_root=url_root,
        custom_base_url=bool(base_url),
        max_tokens=max_tokens,
        reasoning_effort=reasoning_effort,
        http_client=http_client,
    )


def _http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=float(get_settings().AI_REQUEST_TIMEOUT))


def _history(system: str, messages: list[Any]) -> list[BaseMessage]:
    return ([SystemMessage(system)] if system else []) + list(messages)


async def chat(
    *,
    provider: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    system: str = "",
    base_url: str | None = None,
    max_tokens: int = 2048,
    reasoning_effort: str | None = None,
) -> str:
    """Send one turn of `{role, content}` messages and return the reply text."""
    async with _http_client() as http:
        return await _chat(
            provider,
            http,
            api_key=api_key,
            model=model,
            messages=messages,
            system=system,
            base_url=base_url,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
        )


async def _chat(
    provider: str,
    http: httpx.AsyncClient,
    *,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    system: str,
    base_url: str | None,
    max_tokens: int,
    reasoning_effort: str | None,
) -> str:
    llm = await _model_for(
        provider,
        api_key=api_key,
        model=model,
        base_url=base_url,
        max_tokens=max_tokens,
        reasoning_effort=reasoning_effort,
        http_client=http,
    )
    history = _history(
        system,
        [
            user_message(provider, m["content"]) if m["role"] == "user" else assistant_message(provider, m["content"])
            for m in messages
        ],
    )
    try:
        reply = await llm.ainvoke(history)
    except Exception as exc:
        raise _provider_error(provider, exc) from exc
    return reply.text.strip()


async def stream_turn(
    *,
    provider: str,
    api_key: str,
    model: str,
    messages: list[Any],
    system: str,
    tools: list[dict[str, Any]],
    base_url: str | None = None,
    max_tokens: int = 2048,
    reasoning_effort: str | None = None,
) -> AsyncIterator[str | Reasoning | Turn]:
    """One round with tools available, streamed: yields text deltas (str) and
    reasoning-summary pieces (Reasoning) as they arrive and, last, the Turn.

    `messages` is the LangChain conversation built up across rounds by the
    caller (`user_message`, `Turn.raw_message`, `tool_result_message`).
    LangChain assembles streamed tool-call fragments, so a turn that ends in
    tool calls yields its Turn with them parsed and the caller runs them.
    """
    merged: AIMessageChunk | None = None
    async with _http_client() as http:
        llm = await _model_for(
            provider,
            api_key=api_key,
            model=model,
            base_url=base_url,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            http_client=http,
        )
        runnable = llm.bind_tools(_tools(tools)) if tools else llm
        try:
            async for chunk in runnable.astream(_history(system, messages)):
                if not isinstance(chunk, AIMessageChunk):
                    continue
                merged = chunk if merged is None else merged + chunk
                # LangChain's standard blocks: the same "reasoning" shape
                # whichever provider produced it.
                for block in chunk.content_blocks:
                    if block.get("type") == "reasoning" and block.get("reasoning"):
                        yield Reasoning(block["reasoning"])
                piece = chunk.text
                if piece:
                    yield piece
        except Exception as exc:
            raise _provider_error(provider, exc) from exc
    if merged is None:
        raise ProviderError("The provider closed the stream early.")
    message = message_chunk_to_message(merged)
    calls = [
        ToolCall(id=call.get("id") or call["name"], name=call["name"], arguments=call.get("args") or {})
        for call in getattr(message, "tool_calls", []) or []
    ]
    usage = getattr(message, "usage_metadata", None) or {}
    yield Turn(
        text=message.text.strip(),
        tool_calls=calls,
        raw_message=message,
        reasoning_tokens=int((usage.get("output_token_details") or {}).get("reasoning") or 0),
    )


def user_message(provider: str, text: str) -> BaseMessage:
    """A user turn. `provider` is kept for callers; LangChain needs no per-provider shape."""
    return HumanMessage(text)


def assistant_message(provider: str, text: str) -> BaseMessage:
    return AIMessage(text)


def tool_result_message(provider: str, call: ToolCall, result: dict[str, Any]) -> BaseMessage:
    """A tool's output handed back to the model, tied to the call that asked for it."""
    return ToolMessage(content=json.dumps(result), tool_call_id=call.id, name=call.name)
