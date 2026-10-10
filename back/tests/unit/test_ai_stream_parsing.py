"""`ai_providers.stream_turn` / `chat` on LangChain: each provider's real wire
format goes in (canned SSE bodies), text deltas and parsed tool calls come
out. No network — httpx's transport is swapped underneath every SDK."""

import json
from collections.abc import Callable
from pathlib import Path

import httpx
import httpx2
import pytest
from langchain_core.messages import AIMessage

from app.services import ai_providers

FAKE_KEY = "fake-provider-key-not-real"
FIXTURES = Path(__file__).parent / "fixtures"


def _sse(events: list[str], *, named: bool = False) -> bytes:
    """An SSE body. Anthropic's SDK dispatches on the `event:` line too."""
    out = []
    for e in events:
        if named and e != "[DONE]":
            out.append(f"event: {json.loads(e)['type']}\n")
        out.append(f"data: {e}\n\n")
    return "".join(out).encode()


def _serve(monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]) -> list:
    """Answer every request any SDK makes with `handler` — nothing reaches the network.

    Patched at AsyncClient.send, the one call every client goes through
    whatever transport it installs: httpx's (OpenAI, google-genai) and httpx2's
    (the Anthropic SDK's own fork), the latter converted to its own types.
    """
    seen: list = []

    async def send(self: httpx.AsyncClient, request: httpx.Request, **_: object) -> httpx.Response:
        await request.aread()
        seen.append(request)
        response = handler(request)
        response.request = request
        return response

    async def send2(self: "httpx2.AsyncClient", request: "httpx2.Request", **_: object) -> "httpx2.Response":
        await request.aread()
        seen.append(request)
        reply = handler(request)  # type: ignore[arg-type]
        return httpx2.Response(reply.status_code, headers=reply.headers.raw, content=reply.content, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "send", send)
    monkeypatch.setattr(httpx2.AsyncClient, "send", send2)
    return seen


def _stream(body: bytes) -> Callable[[httpx.Request], httpx.Response]:
    return lambda _: httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


async def _collect(**kw) -> tuple[list[str], ai_providers.Turn]:
    deltas: list[str] = []
    turn = None
    async for item in ai_providers.stream_turn(**kw):
        if isinstance(item, ai_providers.Turn):
            turn = item
        else:
            deltas.append(item)
    assert turn is not None
    return deltas, turn


TOOLS = [{"name": "search_notes", "description": "Search", "parameters": {"type": "object", "properties": {}}}]


async def test_openai_stream_text_and_tool_call_fragments(monkeypatch: pytest.MonkeyPatch) -> None:
    body = _sse(
        [
            json.dumps({"choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hel"}}]}),
            json.dumps({"choices": [{"index": 0, "delta": {"content": "lo"}}]}),
            json.dumps(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {"name": "search_notes", "arguments": '{"qu'},
                                    }
                                ]
                            },
                        }
                    ]
                }
            ),
            json.dumps(
                {
                    "choices": [
                        {"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'ery": "x"}'}}]}}
                    ]
                }
            ),
            json.dumps({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}),
            "[DONE]",
        ]
    )
    seen = _serve(monkeypatch, _stream(body))
    deltas, turn = await _collect(
        provider="openai", api_key=FAKE_KEY, model="gpt-4.1", messages=[], system="s", tools=TOOLS
    )
    assert deltas == ["Hel", "lo"]
    assert turn.text == "Hello"
    assert [(c.id, c.name, c.arguments) for c in turn.tool_calls] == [("call_1", "search_notes", {"query": "x"})]
    # The message to echo next round is LangChain's, tool calls and all.
    assert isinstance(turn.raw_message, AIMessage) and turn.raw_message.tool_calls[0]["id"] == "call_1"
    sent = json.loads(seen[0].content)
    assert sent["stream"] is True
    assert sent["messages"][0] == {"role": "system", "content": "s"}
    assert sent["tools"][0]["function"]["name"] == "search_notes"
    assert seen[0].headers["authorization"] == f"Bearer {FAKE_KEY}"


async def test_anthropic_stream_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    usage = {"input_tokens": 1, "output_tokens": 1}
    body = _sse(
        [
            json.dumps(
                {
                    "type": "message_start",
                    "message": {
                        "id": "msg_1",
                        "type": "message",
                        "role": "assistant",
                        "model": "claude-sonnet-4-5",
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": usage,
                    },
                }
            ),
            json.dumps({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            json.dumps({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Let me "}}),
            json.dumps({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "look."}}),
            json.dumps({"type": "content_block_stop", "index": 0}),
            json.dumps(
                {
                    "type": "content_block_start",
                    "index": 1,
                    "content_block": {"type": "tool_use", "id": "tu_1", "name": "read_note", "input": {}},
                }
            ),
            json.dumps(
                {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "input_json_delta", "partial_json": '{"title":'},
                }
            ),
            json.dumps(
                {
                    "type": "content_block_delta",
                    "index": 1,
                    "delta": {"type": "input_json_delta", "partial_json": ' "Home"}'},
                }
            ),
            json.dumps({"type": "content_block_stop", "index": 1}),
            json.dumps(
                {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": usage}
            ),
            json.dumps({"type": "message_stop"}),
        ],
        named=True,
    )
    seen = _serve(monkeypatch, _stream(body))
    deltas, turn = await _collect(
        provider="anthropic",
        api_key=FAKE_KEY,
        model="claude-sonnet-4-5",
        messages=[ai_providers.user_message("anthropic", "hi")],
        system="",
        tools=TOOLS,
    )
    assert "".join(deltas) == "Let me look."
    assert turn.text == "Let me look."
    assert [(c.id, c.name, c.arguments) for c in turn.tool_calls] == [("tu_1", "read_note", {"title": "Home"})]
    assert seen[0].url.path == "/v1/messages"
    assert seen[0].headers["x-api-key"] == FAKE_KEY


async def test_gemini_stream_parts(monkeypatch: pytest.MonkeyPatch) -> None:
    body = _sse(
        [
            json.dumps({"candidates": [{"content": {"role": "model", "parts": [{"text": "Sure, "}]}}]}),
            json.dumps({"candidates": [{"content": {"role": "model", "parts": [{"text": "done."}]}}]}),
            json.dumps(
                {
                    "candidates": [
                        {
                            "content": {
                                "role": "model",
                                "parts": [{"functionCall": {"name": "create_note", "args": {"title": "T"}}}],
                            },
                            "finishReason": "STOP",
                        }
                    ]
                }
            ),
        ]
    )
    seen = _serve(monkeypatch, _stream(body))
    deltas, turn = await _collect(
        provider="gemini",
        api_key=FAKE_KEY,
        model="gemini-2.5-flash",
        messages=[ai_providers.user_message("gemini", "hi")],
        system="",
        tools=TOOLS,
    )
    assert "".join(deltas) == "Sure, done."
    assert turn.text == "Sure, done."
    assert turn.tool_calls[0].name == "create_note" and turn.tool_calls[0].arguments == {"title": "T"}
    assert "streamGenerateContent" in seen[0].url.path


async def test_provider_error_status_is_mapped_not_leaked(monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, lambda _: httpx.Response(401, json={"error": {"message": "bad key sk-secret"}}))
    with pytest.raises(ai_providers.ProviderError) as exc:
        await _collect(provider="openai", api_key=FAKE_KEY, model="m", messages=[], system="", tools=[])
    assert "rejected the API key" in str(exc.value) and "sk-secret" not in str(exc.value)


@pytest.mark.parametrize(
    ("provider", "expected", "absent"),
    [
        # Reasoning models (and Azure OpenAI's v1 endpoint) 400 on max_tokens.
        ("openai", "max_completion_tokens", "max_tokens"),
        ("qwen", "max_tokens", "max_completion_tokens"),
    ],
)
async def test_chat_completions_output_cap_parameter(
    monkeypatch: pytest.MonkeyPatch, provider: str, expected: str, absent: str
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content).get("stream"):
            return _stream(_sse(["[DONE]"]))(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]
            },
        )

    seen = _serve(monkeypatch, handler)
    kw = {"provider": provider, "api_key": FAKE_KEY, "model": "m", "max_tokens": 16}
    assert await ai_providers.chat(messages=[{"role": "user", "content": "hi"}], **kw) == "ok"
    with pytest.raises(ai_providers.ProviderError):  # an empty stream is an early close
        await _collect(messages=[], system="", tools=[], **kw)

    assert len(seen) == 2
    for request in seen:
        payload = json.loads(request.content)
        assert payload[expected] == 16
        assert absent not in payload


@pytest.mark.parametrize(
    ("provider", "effort"),
    [
        ("openai", None),  # thinking off: chat completions, the model's own default
        ("qwen", "high"),  # not a reasoning provider: the setting is ignored
    ],
)
async def test_without_thinking_requests_stay_on_chat_completions(
    monkeypatch: pytest.MonkeyPatch, provider: str, effort: str | None
) -> None:
    seen = _serve(
        monkeypatch,
        lambda _: httpx.Response(
            200,
            json={
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]
            },
        ),
    )
    await ai_providers.chat(
        provider=provider,
        api_key=FAKE_KEY,
        model="m",
        messages=[{"role": "user", "content": "hi"}],
        reasoning_effort=effort,
    )
    sent = json.loads(seen[0].content)
    assert seen[0].url.path.endswith("/chat/completions")
    assert "reasoning_effort" not in sent and "reasoning" not in sent


async def test_thinking_streams_the_reasoning_summary_over_the_responses_api(monkeypatch: pytest.MonkeyPatch) -> None:
    """A real Azure gpt-5.4 stream (encrypted reasoning and ids scrubbed)."""
    events = json.loads((FIXTURES / "openai_responses_reasoning_stream.json").read_text())
    seen = _serve(monkeypatch, _stream(_sse([json.dumps(e) for e in events])))
    reasoning: list[str] = []
    deltas: list[str] = []
    turn = None
    async for item in ai_providers.stream_turn(
        provider="openai",
        api_key=FAKE_KEY,
        model="gpt-5.4",
        messages=[ai_providers.user_message("openai", "Is 91 prime?")],
        system="",
        tools=TOOLS,
        reasoning_effort="high",
    ):
        if isinstance(item, ai_providers.Reasoning):
            reasoning.append(item.text)
        elif isinstance(item, ai_providers.Turn):
            turn = item
        else:
            deltas.append(item)

    sent = json.loads(seen[0].content)
    assert seen[0].url.path.endswith("/responses")
    assert sent["reasoning"] == {"effort": "high", "summary": "auto"}
    # Nothing kept at the provider; the reasoning between rounds rides back encrypted.
    assert sent["store"] is False and "reasoning.encrypted_content" in sent["include"]
    assert "".join(reasoning).startswith("**Verifying if 91 is prime**")
    assert "".join(deltas) == "No, it isn't."
    assert turn is not None and turn.text == "No, it isn't." and turn.tool_calls == []


async def test_a_rejected_reasoning_setting_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    _serve(monkeypatch, lambda _: httpx.Response(400, json={"error": {"param": "reasoning_effort", "message": "nope"}}))
    with pytest.raises(ai_providers.ProviderError, match="reasoning setting"):
        await _collect(
            provider="openai",
            api_key=FAKE_KEY,
            model="gpt-4.1",
            messages=[],
            system="",
            tools=[],
            reasoning_effort="xhigh",
        )


async def test_a_private_base_url_is_refused_before_any_request(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _serve(monkeypatch, lambda _: httpx.Response(200))
    with pytest.raises(ai_providers.ProviderError, match="private or reserved"):
        await _collect(
            provider="openai",
            api_key=FAKE_KEY,
            model="m",
            messages=[],
            system="",
            tools=[],
            base_url="http://127.0.0.1:9/v1",
        )
    assert seen == []
